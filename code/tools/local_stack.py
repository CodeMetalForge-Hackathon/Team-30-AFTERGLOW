#!/usr/bin/env python3
"""The laptop stack in one process, with no MQTT broker: a source -> the real tracker, geofence
and locate -> the dashboard. For laptops without Mosquitto (Windows), and as a demo backup.

    python tools/local_stack.py --config park.toml --speed 5          # fake pod (fake_bus.py's [sim])
    python tools/local_stack.py --config park.toml --replay runs/1432.log --loop   # a recorded real run
    then open http://localhost:8080/tv.html (operator TV), /livemap.html (live map feed) or / (dashboard)

Sources:
    fake (default)  tools/fake_bus.py's FakePod, publishing pose and ble only. Its cheating
                    stand-ins stay off: the real tracker.py, geofence.py and locate.py make every
                    track, pin and coverage grid.
    --replay LOG    a `mosquitto_sub -v` recording, through tools/replay.py's parser. Only the raw
                    inputs are replayed (pose, obs, sos, sensors, sys), so the tracks, pins and
                    coverage are made again by today's tracker, geofence and locate. pose src becomes "replay".

Clicks on either page go through the dashboard's /api/ctrl to the real geofence, so Ack,
Investigate, Clear and Confirm change pins exactly as they do on the pod. Nothing here clicks
by itself: the drone never decides. Pins aren't saved (no pins_file), so each run starts at P1.
Trail pathing: with a case open on the TV and the mode on "search", the fake pod flies the
case's trail (tools/fake_bus.py, Pather).
"""
import argparse
import json
import logging
import random
import sys
import threading
import time
from http.server import ThreadingHTTPServer
from pathlib import Path

import paho.mqtt.client as mqtt

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS.parent))
sys.path.insert(0, str(TOOLS))
from afterglow import config as cfgmod  # noqa: E402
from afterglow.case import CaseStore  # noqa: E402
from afterglow.contracts import ALL, CTRL, MODE, OBS_BLE, OBS_WIFI, POSE, SOS, TRACK, now_ms  # noqa: E402
from afterglow.dashboard import Commands, State, make_handler, make_meta  # noqa: E402
from afterglow.geofence import Geofence  # noqa: E402
from afterglow.locate import MIN_WALL_S as LOCATE_MIN_WALL_S  # noqa: E402
from afterglow.locate import Locate  # noqa: E402
from afterglow.locate import guarded as locate_guarded  # noqa: E402
from afterglow.parkmap import ParkMap  # noqa: E402
from afterglow.tracker import Tracker, guarded  # noqa: E402

log = logging.getLogger("local_stack")

# What a replay feeds in: the pod's raw outputs. Tracks and pins are made again here.
REPLAY_INPUTS = ("ag/pose", "ag/obs/#", "ag/sos", "ag/thermal", "ag/vision", "ag/radar", "ag/sys", "ag/alert")


class LocalBus:
    """In-process stand-in for afterglow.bus.Bus. publish() hands a copy of the message to every
    matching subscriber at once, under one lock, so modules see messages in a single order."""

    def __init__(self):
        self.handlers = []  # (pattern, fn); several per pattern, unlike Bus
        self.lock = threading.RLock()  # re-entrant: a handler may publish (tracker -> geofence)

    def subscribe(self, pattern, fn):
        self.handlers.append((pattern, fn))

    def publish(self, topic, obj, retain=False):
        payload = json.dumps(obj, separators=(",", ":"))  # a copy, as on the wire: no shared dicts
        with self.lock:
            for pattern, fn in list(self.handlers):
                if mqtt.topic_matches_sub(pattern, topic):
                    try:
                        fn(topic, json.loads(payload))
                    except Exception:
                        log.exception("handler for %s failed on %s", pattern, topic)

    def clear_retained(self, topic):
        pass

    def close(self):
        pass


def build(cfg, bus):
    """Wire the dashboard state, the tracker, the geofence and locate onto the bus."""
    pm = ParkMap.load(cfg)
    meta = make_meta(cfg, pm)
    state = State(meta["trail_step_m"])
    state.broker = True  # there's no broker to lose: the in-process bus is always there
    bus.subscribe(ALL, state.on_msg)
    tr = Tracker(cfg, bus)
    for topic in (POSE, "ag/obs/#", CTRL):
        bus.subscribe(topic, lambda t, m: guarded(tr, tr.feed, t, m))
    g = Geofence(cfg, bus, pm=pm)  # no pins_file: nothing saved, every run starts at P1
    for topic in (TRACK, POSE, MODE, CTRL, SOS):
        bus.subscribe(topic, g.feed)
    loc = Locate(cfg, bus, pm=pm)
    last = [0.0]

    def to_locate(topic, msg):
        locate_guarded(loc, loc.feed, topic, msg)
        if time.monotonic() - last[0] >= LOCATE_MIN_WALL_S:  # at most 2 grids a wall second, like locate.py live
            if locate_guarded(loc, loc.maybe_publish):
                last[0] = time.monotonic()
    for topic in (POSE, TRACK, CTRL):
        bus.subscribe(topic, to_locate)
    return pm, meta, state, tr, g


def make_pod(cfg, pm, bus, cases, seed):
    """The fake pod, following the ranger's mode and the open case's trail (sim only)."""
    from fake_bus import FakePod
    pod = FakePod(cfg, pm, random.Random(seed), only={"pose", "ble"})
    pod.set_route(cases.view()["route"])
    cases.listeners.append(lambda view: pod.set_route(view["route"] if view["case"] else None))
    bus.subscribe(MODE, lambda t, m: pod.on_mode(m))
    return pod


def run_fake(pod, bus, speed, stop):
    start, t0 = time.monotonic(), now_ms()
    for topic, msg, retain in pod.run(t0):
        if stop.is_set():
            return
        wait = start + (msg["t"] - t0) / 1000 / speed - time.monotonic()
        if wait > 0:
            stop.wait(wait)
        bus.publish(topic, msg, retain=retain)


def run_replay(path, bus, speed, loop, stop):
    from replay import Opts, parse, schedule
    lines = Path(path).read_text(errors="replace").splitlines()
    o = Opts(speed=speed, topics=REPLAY_INPUTS)
    while not stop.is_set():
        start, sent = time.monotonic(), 0
        for offset, topic, msg, retain in schedule(parse(lines), o):
            wait = start + offset - time.monotonic()
            if wait > 0 and stop.wait(wait):
                return
            if "t" in msg:
                msg["t"] = now_ms()  # moved to now, keeping the gaps, as replay.py does
            bus.publish(topic, msg, retain=retain)
            sent += 1
        log.info("replay: %d messages", sent)
        if not loop or sent == 0:
            return


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", help="profile: afterglow.toml (default) or park.toml")
    ap.add_argument("--speed", type=float, default=1.0, help="time multiplier for the source")
    ap.add_argument("--seed", type=int, help="fake pod random seed, for a repeatable run")
    ap.add_argument("--replay", metavar="LOG", help="replay a mosquitto_sub -v log instead of the fake pod")
    ap.add_argument("--loop", action="store_true", help="with --replay: start again at the end")
    ap.add_argument("--host", default="127.0.0.1", help="address to serve on (0.0.0.0 = every interface)")
    ap.add_argument("--port", type=int, help="HTTP port (default: [http] port)")
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")

    cfg = cfgmod.load(a.config)
    bus = LocalBus()
    pm, meta, state, _, _ = build(cfg, bus)
    cmds = Commands(lambda: bus, cfg["waypoints"])
    dirs = {k: cfgmod.resolve(cfg, cfg["http"][f"{k}_dir"]) for k in ("live", "snaps")}
    cases = CaseStore(cfg, pm)
    cases.listeners.append(lambda view: state.broadcast("case", view))
    stop = threading.Event()
    if a.replay:
        src = lambda: run_replay(a.replay, bus, a.speed, a.loop, stop)  # noqa: E731
    else:
        pod = make_pod(cfg, pm, bus, cases, a.seed)
        src = lambda: run_fake(pod, bus, a.speed, stop)  # noqa: E731
    threading.Thread(target=src, daemon=True, name="source").start()

    server = ThreadingHTTPServer((a.host, a.port or cfg["http"]["port"]), make_handler(state, cmds, meta, dirs, cases))
    server.daemon_threads = True
    port = server.server_address[1]
    log.info("%s: %s -> tracker, geofence, locate -> dashboard, no broker", meta["name"],
             f"replay {a.replay}" if a.replay else "fake pod")
    log.info("operator TV: http://localhost:%d/tv.html   live map: /livemap.html   dashboard: /", port)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        server.server_close()


if __name__ == "__main__":
    main()
