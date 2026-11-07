#!/usr/bin/env python3
"""Check every piece of pod hardware from the Pi, one line each: PASS, FAIL or SKIP.

    python3 tools/check_hw.py              # everything (about 30 s)
    python3 tools/check_hw.py --only gps omni
    python3 tools/check_hw.py --seconds 10 # listen longer on the serial ports

Run it after every hardware change. The bench bring-up stage passes when every
part you've connected shows PASS. Needs pyserial; nothing else beyond the OS tools.
"""
import argparse
import glob
import json
import os
import re
import shutil
import socket
import subprocess
import time

CHECKS = []


def check(name):
    def deco(fn):
        CHECKS.append((name, fn))
        return fn
    return deco


def run(cmd, timeout=15):
    if shutil.which(cmd[0]) is None:
        return None, f"{cmd[0]} not installed"
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, (p.stdout + p.stderr).strip()
    except subprocess.TimeoutExpired:
        return None, "timed out"


def listen(port, baud, seconds, want):
    """Read lines from a serial port; count lines for which want(line) is True."""
    try:
        import serial
    except ImportError:
        return "SKIP", "pip install pyserial"
    if not os.path.exists(port):
        return "FAIL", f"{port} missing (config.txt overlay? reboot?)"
    good = total = 0
    sample = ""
    try:
        with serial.Serial(port, baud, timeout=0.5) as s:
            end = time.time() + seconds
            while time.time() < end:
                raw = s.readline()
                if not raw:
                    continue
                line = raw.decode("utf-8", "replace").strip()
                total += 1
                if want(line):
                    good += 1
                    sample = sample or line[:90]
    except Exception as e:
        return "FAIL", str(e)
    if good:
        return "PASS", f"{good} good lines of {total} in {seconds} s, e.g. {sample}"
    if total:
        return "FAIL", f"{total} lines but none valid: wrong baud, or TX/RX swapped?"
    return "FAIL", "silent: check TX→RX crossing, ground, power and the board's firmware (prints to Serial0?)"


def is_json_type(kind):
    def f(line):
        try:
            return json.loads(line).get("type") == kind
        except Exception:
            return False
    return f


@check("config")
def c_config(a):
    path = "/boot/firmware/config.txt"
    if not os.path.exists(path):
        return "SKIP", "not on a Pi"
    text = open(path).read()
    need = ["dtparam=i2c_arm=on", "dtparam=uart0=on", "dtoverlay=uart3-pi5", "dtoverlay=uart2-pi5",
            "usb_max_current_enable=1", "camera_auto_detect=1", "dtparam=pciex1_gen=3"]
    missing = [n for n in need if n not in text]
    return ("FAIL", "missing: " + ", ".join(missing)) if missing else ("PASS", "all lines present")


@check("power")
def c_power(a):
    rc, out = run(["vcgencmd", "get_throttled"])
    if rc is None:
        return "SKIP", out
    m = re.search(r"0x[0-9a-fA-F]+", out)
    val = m.group(0) if m else out
    _, temp = run(["vcgencmd", "measure_temp"])
    if val == "0x0":
        return "PASS", f"throttled=0x0, {temp}"
    return "FAIL", f"throttled={val} (under-voltage or heat; see docs/HARDWARE.md, Power), {temp}"


@check("serial_ports")
def c_ports(a):
    missing = [p for p in ("/dev/ttyAMA0", "/dev/ttyAMA2", "/dev/ttyAMA3") if not os.path.exists(p)]
    return ("FAIL", "missing " + ", ".join(missing)) if missing else ("PASS", "ttyAMA0, 2, 3 present")


@check("omni")
def c_omni(a):
    return listen("/dev/ttyAMA0", 921600, a.seconds, is_json_type("ble"))


@check("wifi")
def c_wifi(a):
    return listen("/dev/ttyAMA3", 921600, a.seconds, is_json_type("wifi"))


@check("gps")
def c_gps(a):
    fix_seen = []

    def nmea(line):
        if line.startswith("$G") and "*" in line:
            if line[3:6] == "GGA":
                parts = line.split(",")
                if len(parts) > 6 and parts[6] not in ("", "0"):
                    fix_seen.append(line)
            return True
        return False
    last = ("FAIL", "no NMEA at 38400, 9600 or 115200")
    for baud in (38400, 9600, 115200):
        st, msg = listen("/dev/ttyAMA2", baud, max(3, a.seconds // 2), nmea)
        if st == "PASS":
            fix = "has a fix" if fix_seen else "no fix yet (take it outside or to a window)"
            return "PASS", f"NMEA at {baud} baud, {fix}. Set gps_baud = {baud} in afterglow.toml"
        last = (st, msg)
        if "missing" in msg:
            break
    return last


@check("i2c")
def c_i2c(a):
    rc, out = run(["i2cdetect", "-y", "1"])
    if rc is None:
        return "SKIP", out + " (sudo apt install i2c-tools)"
    found = set(re.findall(r"\b([0-9a-f]{2})\b", "\n".join(l.split(":", 1)[1] for l in out.splitlines() if ":" in l)))
    want = {"4a": "IMU (BNO085)", "33": "thermal (MLX90640)"}
    missing = [f"{v} at 0x{k}" for k, v in want.items() if k not in found]
    if missing:
        return "FAIL", "not found: " + "; ".join(missing) + f" (found {sorted(found) or 'nothing'})"
    return "PASS", "0x4a IMU and 0x33 thermal answer"


@check("camera")
def c_camera(a):
    rc, out = run(["rpicam-hello", "--list-cameras"], timeout=20)
    if rc is None:
        return "SKIP", out
    if "imx708" in out.lower():
        return "PASS", "Camera Module 3 (imx708) found"
    return "FAIL", "no camera: ribbon seated, contacts the right way, camera_auto_detect=1? " + out[:80]


@check("hailo")
def c_hailo(a):
    rc, out = run(["hailortcli", "fw-control", "identify"], timeout=20)
    if rc is None:
        return "SKIP", out + " (sudo apt install hailo-all)"
    if rc == 0 and "hailo" in out.lower():
        line = next((l for l in out.splitlines() if "Board Name" in l or "Device Architecture" in l), "found")
        return "PASS", line.strip()
    return "FAIL", "AI HAT+ not found: PCIe ribbon seated? dtparam=pciex1_gen=3? " + out[:80]


@check("usb_serial")
def c_usb(a):
    byid = sorted(glob.glob("/dev/serial/by-id/*"))
    links = [p for p in ("/dev/lora", "/dev/radar") if os.path.exists(p)]
    if not byid:
        return "FAIL", "no USB serial devices: LoRa board and radar plugged in?"
    names = ", ".join(os.path.basename(p) for p in byid)
    note = f"; udev links: {', '.join(links)}" if links else "; add udev links (pi/99-afterglow.rules)"
    return ("PASS" if len(byid) >= 2 else "FAIL"), f"{len(byid)} found: {names}{note}"


@check("mqtt")
def c_mqtt(a):
    try:
        with socket.create_connection(("localhost", 1883), timeout=2):
            return "PASS", "Mosquitto listening on 1883"
    except OSError as e:
        return "FAIL", f"no broker on localhost:1883 ({e}); sudo systemctl enable --now mosquitto"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", nargs="*", help="names: " + " ".join(n for n, _ in CHECKS))
    ap.add_argument("--seconds", type=int, default=5, help="how long to listen on each serial port")
    a = ap.parse_args()
    width = max(len(n) for n, _ in CHECKS)
    results = []
    for name, fn in CHECKS:
        if a.only and name not in a.only:
            continue
        try:
            st, msg = fn(a)
        except Exception as e:  # a check must never crash the run
            st, msg = "FAIL", f"error: {e}"
        results.append(st)
        print(f"{st:4}  {name:<{width}}  {msg}", flush=True)
    print(f"\n{results.count('PASS')} pass, {results.count('FAIL')} fail, {results.count('SKIP')} skipped")
    raise SystemExit(1 if "FAIL" in results else 0)


if __name__ == "__main__":
    main()
