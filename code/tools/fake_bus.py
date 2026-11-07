#!/usr/bin/env python3
"""Fake pod: stands in for the pod, and for now also for tracker, locate and geofence, so the
dashboard can be built and shown before the hardware and Phase 2 land.

    python3 tools/fake_bus.py                                    # demo profile: indoor waypoint loop
    python3 tools/fake_bus.py --config park.toml --speed 10      # park profile: lanes at Blackwoods
    python3 tools/fake_bus.py --print --duration 20 | head       # no broker: print to the screen
    python3 tools/fake_bus.py --only pose,ble                    # once tracker, locate and geofence are real

What it publishes (pick with --only):
    pose      ag/pose at [pose] publish_hz, src "sim" (the dashboard badges it SIMULATED)
    ble       ag/obs/ble, about one advert a second for each phone in range
    track     ag/track once a second per heard phone       (stand-in for tracker.py)
    coverage  ag/coverage once a second, retained          (stand-in for locate; wiped on exit)
    target    ag/target once a second per pin               (stand-in for geofence.py)

The profile's [sim] table sets the path, the hidden phones and the RSSI model. The path is a
dumb stand-in, a waypoint loop or fixed lanes; real routes come from planner.py.

The stand-in tracker CHEATS: it knows where each phone really is and adds an error that
shrinks with every strong pass (r95 = 2.5 x localized_r95_m / passes^1.5). It only makes
the dashboard look right; accuracy numbers (I6, I8) must come from the real modules.
Fake pins stay at status "new": only the ranger changes a pin.
Each phone's id rotates every 15 minutes, like Find My, each at its own moment. `t` runs on simulated time, so
with --speed 5 it runs 5x faster than the wall clock.
"""
import argparse
import hashlib
import math
import random
import signal
import sys
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from afterglow import config, geo  # noqa: E402
from afterglow.contracts import (ALWAYS_REPORTED, COVERAGE, OBS_BLE, POSE, TARGET,  # noqa: E402
                                 TRACK, now_ms)
from afterglow.parkmap import ParkMap  # noqa: E402

TOPICS = {"pose": POSE, "ble": OBS_BLE, "track": TRACK, "coverage": COVERAGE, "target": TARGET}
ADVERT_HZ = 1.0  # adverts a second per phone
ROTATE_MS = 900_000  # Find My key rotation


@dataclass
class Phone:
    name: str
    cls: str
    x: float | None  # None = rides on the pod
    y: float | None
    ids: list = field(default_factory=list)
    best: dict = field(default_factory=dict)  # pass number -> loudest RSSI on that pass
    loudest: tuple | None = None  # (rssi, x, y) of the loudest advert so far
    last_t: int | None = None
    track: str | None = None
    pin: str | None = None
    err: tuple = (0.0, 0.0, -1)  # estimate offset (dx, dy) and the pass count it was drawn for

    @property
    def with_drone(self):
        return self.x is None

    @property
    def phase(self):
        """Each phone rotates its key at its own moment, as real ones do, not all at once."""
        return int(hashlib.sha256(self.name.encode()).hexdigest()[:8], 16) % ROTATE_MS


def walk(verts, step):
    """Points every `step` metres along a polyline, with the index of the segment they're on."""
    carry = 0.0
    for i, (a, b) in enumerate(zip(verts, verts[1:])):
        seg = math.dist(a, b)
        d = carry
        while d < seg:
            f = d / seg
            yield (a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])), i
            d += step
        carry = d - seg


def path(cfg, area, dt):
    """Endless (x, y, pass number). Waypoints: one pass per loop. Lanes: one pass per lane."""
    sim = cfg["sim"]
    step = sim["speed_mps"] * dt
    if sim["path"] == "waypoints":
        wp = [cfg["waypoints"][n] for n in sorted(cfg["waypoints"])]
        if len(wp) < 2:
            sys.exit("[sim] path = \"waypoints\" needs at least two [waypoints]")
        loop, n = wp + [wp[0]], 0
        while True:
            for pt, _ in walk(loop, step):
                yield pt[0], pt[1], n
            n += 1
    elif sim["path"] == "lanes":
        x0, y0, x1, y1 = area
        verts, y, east = [], y0, True
        while y <= y1 + 1e-6:
            verts += [(x0, y), (x1, y)] if east else [(x1, y), (x0, y)]
            y += sim["lane_m"]
            east = not east
        done = 0
        while True:  # sweep up, then back down the same lanes
            for pt, i in walk(verts, step):
                yield pt[0], pt[1], done + (i + 1) // 2
            done += len(verts) // 2
            verts = verts[::-1]
    else:
        sys.exit(f"[sim] path must be \"waypoints\" or \"lanes\", not {sim['path']!r}")


class FakePod:
    def __init__(self, cfg, pm: ParkMap, rng: random.Random, only=frozenset(TOPICS)):
        self.cfg, self.pm, self.rng, self.only = cfg, pm, rng, set(only)
        sim = cfg["sim"]
        self.sim = sim
        self.dt = 1.0 / cfg["pose"]["publish_hz"]
        self.L = cfg["track"]["localized_r95_m"]
        self.P = cfg["track"]["pinned_r95_m"]
        area = sim["area_m"] if sim.get("area_m") else pm.bounds()
        self.area = tuple(round(v, 2) for v in area)  # the map's lon/lat round trip leaves float dust
        self.phones = [Phone(p["name"], p["cls"], p.get("x"), p.get("y")) for p in sim["phones"]]
        # A pass counts for a phone once it's heard at least as loud as the model gives at detect_m
        self.strong = self.model_rssi(math.hypot(cfg["locate"]["detect_m"], sim["height_m"]))
        # Coverage grid over the area
        self.cell = cfg["locate"]["cell_m"]
        x0, y0, x1, y1 = self.area
        self.nx = max(1, math.ceil((x1 - x0) / self.cell - 1e-6))
        self.ny = max(1, math.ceil((y1 - y0) / self.cell - 1e-6))
        self.covered = bytearray(self.nx * self.ny)
        self.n_tracks = self.n_pins = 0

    def model_rssi(self, dist):
        return self.sim["rssi_p0"] - 10 * self.sim["rssi_n"] * math.log10(max(dist, 1.0))

    def run(self, t0, duration_s=None):
        """Yield (topic, msg, retain) forever, or for duration_s simulated seconds."""
        per_tick = max(1, round(1.0 / self.dt))  # the once-a-second outputs
        h = self.sim["height_m"]
        for step, (x, y, pass_no) in enumerate(path(self.cfg, self.area, self.dt)):
            if duration_s is not None and step * self.dt > duration_s:
                return
            t = t0 + int(step * self.dt * 1000)
            if "pose" in self.only:
                yield POSE, {"t": t, "x": round(x, 2), "y": round(y, 2), "z": h, "src": "sim"}, False
            self.mark_covered(x, y)
            for ph in self.phones:
                if self.rng.random() > self.dt * ADVERT_HZ:
                    continue
                d = 0.5 if ph.with_drone else math.sqrt((x - ph.x) ** 2 + (y - ph.y) ** 2 + h * h)
                rssi = round(self.model_rssi(d) + self.rng.gauss(0, self.sim["rssi_sigma"]))
                if rssi < self.sim["rssi_floor"]:
                    continue
                pid = hashlib.sha256(f"{ph.name}-{(t + ph.phase) // ROTATE_MS}".encode()).hexdigest()[:8]
                self.heard(ph, pid, t, x, y, rssi, pass_no)
                if "ble" in self.only:
                    yield OBS_BLE, {"t": t, "src": "omni", "id": pid, "cls": ph.cls, "rssi": rssi}, False
            if step % per_tick == 0:
                yield from self.tick(t, x, y)

    def heard(self, ph, pid, t, x, y, rssi, pass_no):
        if pid not in ph.ids:
            ph.ids.append(pid)
        ph.last_t = t
        ph.best[pass_no] = max(rssi, ph.best.get(pass_no, -999))
        if ph.loudest is None or rssi > ph.loudest[0]:
            ph.loudest = (rssi, x, y)
        if ph.track is None:
            self.n_tracks += 1
            ph.track = f"T{self.n_tracks}"

    def mark_covered(self, px, py):
        x0, y0 = self.area[0], self.area[1]
        r, c = self.cfg["locate"]["detect_m"], self.cell
        for row in range(max(0, int((py - r - y0) / c)), min(self.ny, int((py + r - y0) / c) + 1)):
            for col in range(max(0, int((px - r - x0) / c)), min(self.nx, int((px + r - x0) / c) + 1)):
                if math.hypot(x0 + (col + 0.5) * c - px, y0 + (row + 0.5) * c - py) <= r:
                    self.covered[row * self.nx + col] = 1

    def estimate(self, ph, px, py):
        """(x, y, r95, passes): the cheating stand-in for tracker + locate (see the docstring)."""
        if ph.with_drone:
            return px, py, 2 * self.L, len(ph.best)
        k = sum(1 for r in ph.best.values() if r >= self.strong)
        if k == 0:  # only faint so far: somewhere near the loudest spot
            _, lx, ly = ph.loudest
            return lx, ly, min(255.0, 3 * self.L), 0
        # heard, then localized at 2-3 passes, pinned at 4; never tighter than 60% of the pinned radius
        r95 = min(255.0, max(0.6 * self.P, 2.5 * self.L / k ** 1.5))
        if ph.err[2] != k:  # new strong pass: draw a new error, so the pin moves once per pass
            s = r95 / 2.45  # 95% of a 2-D Gaussian lies within 2.45 sigma
            ph.err = (self.rng.gauss(0, s), self.rng.gauss(0, s), k)
        return ph.x + ph.err[0], ph.y + ph.err[1], r95, k

    def state(self, r95):
        return "pinned" if r95 <= self.P else "localized" if r95 <= self.L else "heard"

    def tick(self, t, px, py):
        tracks = []
        for ph in self.phones:
            if ph.track is None:
                continue
            ex, ey, r95, k = self.estimate(ph, px, py)
            st = self.state(r95)
            last_s = (t - ph.last_t) // 1000
            c = round(min(0.95, 0.3 + 0.12 * k), 2)
            tracks.append((ph, ex, ey, r95, st, c, k))
            if "track" in self.only:
                yield TRACK, {"t": t, "track": ph.track, "ids": ph.ids[-4:], "cls": ph.cls,
                              "x": round(ex, 1), "y": round(ey, 1), "r95": round(r95, 1), "state": st,
                              "passes": len(ph.best), "last_s": last_s, "with_drone": ph.with_drone,
                              "baseline": False, "c": 0.0 if ph.with_drone else c}, False
            if ph.with_drone or ph.cls not in ALWAYS_REPORTED or k == 0:
                continue
            if ph.pin is None:
                self.n_pins += 1
                ph.pin = f"P{self.n_pins}"
            if "target" in self.only:
                yield TARGET, self.target(t, ph, ex, ey, r95, st, c, k, last_s), False
        if "coverage" in self.only:
            yield COVERAGE, self.coverage(t, tracks), True

    def target(self, t, ph, x, y, r95, st, c, k, last_s):
        rules = self.cfg["rules"]
        off = self.pm.dist_to_trail(x, y)
        off = 9999 if math.isinf(off) else round(off)
        z = self.pm.zone_at(x, y)
        if z is not None and z.kind != "park":
            zone = z.id
        else:
            zone = "trail_corridor" if off <= rules["offtrail_m"] else "off_trail"
        rule = "day_offtrail" if off > rules["offtrail_m"] and k >= rules["min_passes"] else "search"
        prio = 2 if st == "pinned" and c >= 0.8 else 3 if st == "localized" or c >= 0.5 else 4
        lat, lon = geo.to_latlon(x, y, self.cfg["mission"]["origin_lat"], self.cfg["mission"]["origin_lon"])
        return {"t": t, "pin": ph.pin, "track": ph.track, "x": round(x, 1), "y": round(y, 1),
                "lat": round(lat, 7), "lon": round(lon, 7), "r95": round(r95, 1), "c": c, "prio": prio,
                "cls": ph.cls, "state": st, "last_s": last_s, "off_trail_m": off, "zone": zone,
                "rule": rule, "status": "new",
                "flags": {"sos": False, "thermal": False, "radar": False, "camera": False}, "br": None}

    def coverage(self, t, tracks):
        """The probability grid is a Gaussian blob per pinned track, scaled by its confidence."""
        x0, y0 = self.area[0], self.area[1]
        p = [0] * (self.nx * self.ny)
        for ph, ex, ey, r95, _, c, _ in tracks:
            if ph.with_drone:
                continue
            s = max(r95 / 2.45, self.cell / 2)
            reach = 3 * s
            for row in range(max(0, int((ey - reach - y0) / self.cell)),
                             min(self.ny, int((ey + reach - y0) / self.cell) + 1)):
                cy = y0 + (row + 0.5) * self.cell
                for col in range(max(0, int((ex - reach - x0) / self.cell)),
                                 min(self.nx, int((ex + reach - x0) / self.cell) + 1)):
                    cx = x0 + (col + 0.5) * self.cell
                    v = int(255 * c * math.exp(-((cx - ex) ** 2 + (cy - ey) ** 2) / (2 * s * s)))
                    i = row * self.nx + col
                    p[i] = max(p[i], v)
        n = self.nx * self.ny
        return {"t": t, "x0": round(x0, 2), "y0": round(y0, 2), "cell_m": self.cell, "nx": self.nx,
                "ny": self.ny, "covered": list(self.covered), "p": p, "pct": round(sum(self.covered) / n, 3)}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", help="profile: afterglow.toml (default, or AFTERGLOW_CONFIG) or park.toml")
    ap.add_argument("--host", help="MQTT host (default: the config's [mqtt] host)")
    ap.add_argument("--port", type=int, help="MQTT port (default: the config's [mqtt] port)")
    ap.add_argument("--speed", type=float, default=1.0, help="time multiplier")
    ap.add_argument("--print", action="store_true", help="print instead of publishing (no waiting)")
    ap.add_argument("--only", default=",".join(TOPICS), help=f"comma list from {','.join(TOPICS)}")
    ap.add_argument("--duration", type=float, help="stop after this many simulated seconds")
    ap.add_argument("--seed", type=int, help="random seed, for a repeatable run")
    a = ap.parse_args()

    only = {s.strip() for s in a.only.split(",") if s.strip()}
    if only - TOPICS.keys():
        ap.error(f"--only: unknown {sorted(only - TOPICS.keys())}; pick from {','.join(TOPICS)}")
    cfg = config.load(a.config)
    pod = FakePod(cfg, ParkMap.load(cfg), random.Random(a.seed), only)
    print(f"fake_bus: {Path(cfg['_path']).name}, {cfg['sim']['path']} path, "
          f"{len(pod.phones)} phones, publishing {','.join(sorted(only))}", file=sys.stderr)

    if a.print:
        from afterglow.bus import PrintBus
        bus = PrintBus()
    else:
        from afterglow.bus import Bus
        bus = Bus(a.host or cfg["mqtt"]["host"], a.port or cfg["mqtt"]["port"], name="fake_bus")

    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))  # `kill` cleans up like Ctrl+C
    start = time.monotonic()
    t0 = now_ms()
    try:
        for topic, msg, retain in pod.run(t0, a.duration):
            if not a.print:  # keep to the schedule: simulated time / speed
                wait = start + (msg["t"] - t0) / 1000 / a.speed - time.monotonic()
                if wait > 0:
                    time.sleep(wait)
            bus.publish(topic, msg, retain=retain)
    finally:
        if "coverage" in only:  # don't leave a fake grid on the broker for the next run or profile
            bus.clear_retained(COVERAGE)
        bus.close()


if __name__ == "__main__":
    try:
        main()
    except (KeyboardInterrupt, BrokenPipeError):
        pass
