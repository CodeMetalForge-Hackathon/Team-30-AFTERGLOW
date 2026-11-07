"""position.py (tier 1, Utility): GPS NMEA on ttyAMA2 -> ag/pose. Indoors: taped waypoints.

    python -m afterglow.position                     # on the Pi
    python -m afterglow.position --dry-run < nmea.txt   # no hardware, no broker
    # indoors, the dashboard (or you) taps a waypoint:
    mosquitto_pub -t ag/ctrl -m '{"cmd":"waypoint","n":3}'

The FPV's flight controller doesn't share its position, so the pod reads its own GPS.
"""
import argparse
import logging
import sys
import threading

import pynmea2

from . import config as cfgmod
from . import geo
from .bus import Bus, PrintBus
from .contracts import CTRL, POSE, now_ms

log = logging.getLogger("position")
KNOT = 0.514444


class Position:
    def __init__(self, cfg: dict, bus):
        self.bus = bus
        m = cfg["mission"]
        self.lat0, self.lon0 = m.get("origin_lat", 0.0), m.get("origin_lon", 0.0)
        self.have_origin = not (self.lat0 == 0.0 and self.lon0 == 0.0)
        self.carry_h = cfg["pose"].get("carry_height_m", 3.0)
        self.min_dt = 1000 / cfg["pose"].get("publish_hz", 5)
        self.waypoints = cfg.get("waypoints", {})
        self.takeoff_alt = None
        self.course = self.speed = None
        self.last_pub = 0
        self.no_fix = 0

    def handle_nmea(self, line: str, t: int | None = None):
        """Feed one NMEA sentence; returns the pose it published, if any."""
        if not line.startswith("$"):
            return None
        try:
            msg = pynmea2.parse(line)
        except pynmea2.ParseError:
            return None
        if isinstance(msg, pynmea2.types.talker.RMC):
            if msg.spd_over_grnd is not None:
                self.speed = round(float(msg.spd_over_grnd) * KNOT, 2)
            if msg.true_course is not None:
                self.course = float(msg.true_course)
            return None
        if not isinstance(msg, pynmea2.types.talker.GGA):
            return None
        fix = int(msg.gps_qual or 0)
        if fix == 0 or msg.latitude == 0.0:
            self.no_fix += 1
            return None
        lat, lon = msg.latitude, msg.longitude
        alt = float(msg.altitude) if msg.altitude is not None else None
        if not self.have_origin:
            self.lat0, self.lon0, self.have_origin = lat, lon, True
            log.warning("origin set from first fix: origin_lat = %.7f, origin_lon = %.7f "
                        "(copy into afterglow.toml on the pod AND the laptop)", lat, lon)
        if self.takeoff_alt is None and alt is not None:
            self.takeoff_alt = alt
        t = t or now_ms()
        if t - self.last_pub < self.min_dt:
            return None
        x, y = geo.to_xy(lat, lon, self.lat0, self.lon0)
        z = max(0.0, alt - self.takeoff_alt) if alt is not None and self.takeoff_alt is not None else self.carry_h
        pose = {"t": t, "x": round(x, 2), "y": round(y, 2), "z": round(z, 1),
                "lat": round(lat, 7), "lon": round(lon, 7), "alt_m": alt,
                "course": self.course, "speed_mps": self.speed,
                "fix": fix, "sats": int(msg.num_sats or 0), "src": "gps"}
        self.last_pub = t
        self.bus.publish(POSE, pose)
        return pose

    def on_ctrl(self, topic, msg):
        if msg.get("cmd") != "waypoint":
            return
        n = int(msg.get("n", -1))
        if n not in self.waypoints:
            log.warning("unknown waypoint %s", n)
            return
        x, y = self.waypoints[n]
        lat, lon = geo.to_latlon(x, y, self.lat0, self.lon0)
        self.bus.publish(POSE, {"t": now_ms(), "x": x, "y": y, "z": self.carry_h,
                                "lat": round(lat, 7), "lon": round(lon, 7), "src": "waypoint", "n": n})


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config")
    ap.add_argument("--dry-run", action="store_true", help="read NMEA from stdin, print instead of publishing")
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    cfg = cfgmod.load(a.config)

    if a.dry_run:
        p = Position(cfg, PrintBus())
        p.min_dt = 0
        for line in sys.stdin:
            p.handle_nmea(line.strip())
        return

    import serial
    bus = Bus(cfg["mqtt"]["host"], cfg["mqtt"]["port"], "position")
    p = Position(cfg, bus)
    bus.subscribe(CTRL, p.on_ctrl)
    port, baud = cfg["serial"]["gps"], cfg["serial"]["gps_baud"]
    if not port:  # no GPS receiver yet: only the taped waypoints move ag/pose
        log.info("no GPS in the config ([serial] gps = \"\"): waypoints only")
        try:
            threading.Event().wait()
        except KeyboardInterrupt:
            bus.close()
        return
    while True:
        try:
            with serial.Serial(port, baud, timeout=2) as s:
                log.info("GPS on %s at %d", port, baud)
                while True:
                    raw = s.readline()
                    if raw:
                        p.handle_nmea(raw.decode("ascii", "replace").strip())
        except Exception as e:
            log.error("GPS %s: %s; retrying in 2 s", port, e)
            threading.Event().wait(2)


if __name__ == "__main__":
    main()
