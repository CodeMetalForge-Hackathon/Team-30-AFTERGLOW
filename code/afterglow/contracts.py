"""Topic names and message shapes, as code. docs/CONTRACTS.md is the readable version.

Change this file and docs/CONTRACTS.md together, in one commit, and tell the team.
"""
import time

OBS_BLE = "ag/obs/ble"
OBS_WIFI = "ag/obs/wifi"
SOS = "ag/sos"
POSE = "ag/pose"
PASS = "ag/pass"
COVERAGE = "ag/coverage"
TRACK = "ag/track"
TARGET = "ag/target"
THERMAL = "ag/thermal"
VISION = "ag/vision"
RADAR = "ag/radar"
PLAN = "ag/plan"
MODE = "ag/mode"
CTRL = "ag/ctrl"
SYS = "ag/sys"
ALL = "ag/#"

# Beacon classes, and their 4-bit codes in the LoRa alert
CLS_CODES = {"other": 0, "findmy": 1, "findhub": 2, "samsung_off": 3, "ref": 4, "wifi": 5}
ALWAYS_REPORTED = {"findmy", "findhub", "samsung_off", "ref"}

STATES = ["heard", "localized", "pinned", "confirmed"]  # order = the alert's state code
TRACK_STATES = STATES[:3]  # only the ranger's Confirm sets "confirmed", on ag/target; the tracker never does
MODES = ["patrol", "night", "investigate", "search"]
PIN_STATUS = ["new", "acknowledged", "investigating", "confirmed", "cleared"]
RULES = ["day_offtrail", "night_outside_camp", "search", "sos"]
CTRL_CMDS = {
    "new_search", "baseline_start", "baseline_stop",
    "ack", "investigate", "clear", "confirm",
    "accept_leg", "reject_leg", "waypoint",
    "lora_off", "lora_on", "sos_on", "sos_off",
}

# Minimum keys each topic must carry. Extra keys are allowed.
REQUIRED = {
    OBS_BLE: {"t", "src", "id", "cls", "rssi"},
    OBS_WIFI: {"t", "id", "rand", "rssi", "ch"},
    SOS: {"t", "hurt", "walk", "count"},
    POSE: {"t", "x", "y", "z", "src"},
    PASS: {"t", "track", "peak_x", "peak_y", "sharp"},
    COVERAGE: {"t", "x0", "y0", "cell_m", "nx", "ny", "covered", "p", "pct"},
    TRACK: {"t", "track", "cls", "x", "y", "r95", "state", "last_s"},
    TARGET: {"t", "pin", "track", "x", "y", "r95", "c", "prio", "cls", "status", "state", "last_s"},
    THERMAL: {"t", "max_c", "hot"},
    VISION: {"t", "kind", "conf"},
    RADAR: {"t", "present"},
    PLAN: {"t", "id", "kind", "legs", "status"},
    MODE: {"t", "mode"},
    CTRL: {"cmd"},
    SYS: {"t"},
}


def now_ms() -> int:
    return int(time.time() * 1000)


def validate(topic: str, msg: dict) -> list[str]:
    """Return a list of problems; empty means the message matches the contract."""
    problems = []
    need = REQUIRED.get(topic)
    if need is None:
        return [f"unknown topic {topic}"]
    missing = need - msg.keys()
    if missing:
        problems.append(f"{topic} missing {sorted(missing)}")
    if topic == OBS_BLE and msg.get("cls") not in CLS_CODES:
        problems.append(f"bad cls {msg.get('cls')!r}")
    if topic == TRACK and msg.get("state") not in TRACK_STATES:
        problems.append(f"bad track state {msg.get('state')!r}")
    if topic == TARGET and msg.get("state") not in STATES:
        problems.append(f"bad state {msg.get('state')!r}")
    if topic == TARGET and "rule" in msg and msg["rule"] not in RULES:
        problems.append(f"bad rule {msg['rule']!r}")
    if topic == COVERAGE:
        n = msg.get("nx", 0) * msg.get("ny", 0)
        for key in ("covered", "p"):
            if len(msg.get(key) or []) != n:
                problems.append(f"{key} must have nx*ny = {n} cells")
    if topic == MODE and msg.get("mode") not in MODES:
        problems.append(f"bad mode {msg.get('mode')!r}")
    if topic == CTRL and msg.get("cmd") not in CTRL_CMDS:
        problems.append(f"bad cmd {msg.get('cmd')!r}")
    if topic == TARGET and msg.get("status") not in PIN_STATUS:
        problems.append(f"bad status {msg.get('status')!r}")
    return problems
