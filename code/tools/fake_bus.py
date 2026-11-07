#!/usr/bin/env python3
"""Fake pod: publishes ag/pose and ag/obs/ble so tracker, locate and dashboard work
can start before the hardware does. Runs anywhere with Python and an MQTT broker
(a laptop with Mosquitto is fine).

    python3 tools/fake_bus.py                 # to localhost:1883, real time
    python3 tools/fake_bus.py --speed 5       # 5x faster
    python3 tools/fake_bus.py --print | head  # no broker: print to the screen

The drone flies lawnmower lanes 20 m apart at 8 m height over a 200 x 120 m area.
Hidden: a dead iPhone at (120, 76), an AirTag at (60, 32), and a team phone that
rides on the drone (the "moves with the drone" filter should drop it). Each changes
its hashed id every 15 minutes, like Find My's key rotation.
RSSI uses a log-distance model with noise; it is a stand-in until ME 2's range test.
"""
import argparse
import hashlib
import json
import math
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from afterglow.contracts import OBS_BLE, POSE  # noqa: E402

PHONES = [  # name, cls, x, y (None = rides on the drone)
    ("dead_iphone", "findmy", 120.0, 76.0),
    ("airtag_trail", "findmy", 60.0, 32.0),
    ("team_phone", "findmy", None, None),  # rides on the drone
]


def lanes(width=200, height=120, spacing=20, speed=5.0, dt=0.2):
    y, d = 0.0, 1
    while y <= height:
        xs = (0, width) if d > 0 else (width, 0)
        n = int(abs(xs[1] - xs[0]) / (speed * dt))
        for i in range(n + 1):
            yield xs[0] + d * i * speed * dt, y
        y += spacing
        d = -d


def rssi_at(dist, n=2.4, p0=-48, sigma=4.0):
    return p0 - 10 * n * math.log10(max(dist, 1.0)) + random.gauss(0, sigma)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="localhost")
    ap.add_argument("--port", type=int, default=1883)
    ap.add_argument("--speed", type=float, default=1.0, help="time multiplier")
    ap.add_argument("--print", action="store_true", help="print instead of publishing")
    ap.add_argument("--height", type=float, default=8.0)
    a = ap.parse_args()

    if a.print:
        pub = lambda topic, m: print(topic, json.dumps(m))  # noqa: E731
    else:
        import paho.mqtt.client as mqtt
        c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="fake_bus")
        c.connect(a.host, a.port)
        c.loop_start()
        pub = lambda topic, m: c.publish(topic, json.dumps(m))  # noqa: E731

    dt = 0.2
    t = int(time.time() * 1000)
    for step, (x, y) in enumerate(lanes(dt=dt)):
        t += int(dt * 1000)
        pub(POSE, {"t": t, "x": round(x, 2), "y": round(y, 2), "z": a.height, "src": "replay"})
        for name, cls, px, py in PHONES:
            if random.random() > dt:  # about one advert per second each
                continue
            if px is None:
                dist = 0.5
            else:
                dist = math.sqrt((x - px) ** 2 + (y - py) ** 2 + a.height ** 2)
            r = rssi_at(dist)
            if r < -98:
                continue
            key = f"{name}-{(t // 900_000)}"  # new hashed id every 15 minutes, like Find My
            pub(OBS_BLE, {"t": t, "src": "omni", "id": hashlib.sha256(key.encode()).hexdigest()[:8],
                          "cls": cls, "rssi": round(r)})
        if not a.print:
            time.sleep(dt / a.speed)


if __name__ == "__main__":
    try:
        main()
    except (KeyboardInterrupt, BrokenPipeError):
        pass
