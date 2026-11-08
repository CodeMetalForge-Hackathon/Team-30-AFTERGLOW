"""tools/fake_bus.py: every message matches the contract, in both profiles."""
import random
import sys
from pathlib import Path

import pytest

from afterglow import config
from afterglow.contracts import COVERAGE, OBS_BLE, POSE, TARGET, THERMAL, TRACK, VISION, validate
from afterglow.parkmap import ParkMap

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
from fake_bus import FakePod  # noqa: E402

PROFILES = {"indoor": (config.DEFAULT, 240), "park": (config.DEFAULT.parent / "park.toml", 2400)}


def run(profile, seconds=None, only=None, seed=7):
    path, default_s = PROFILES[profile]
    cfg = config.load(path)
    kw = {} if only is None else {"only": only}
    pod = FakePod(cfg, ParkMap.load(cfg), random.Random(seed), **kw)
    return cfg, list(pod.run(1_731_000_000_000, seconds or default_s))


@pytest.fixture(scope="module", params=list(PROFILES))
def out(request):
    return request.param, *run(request.param)


def test_every_message_validates(out):
    _, _, msgs = out
    for topic, msg, _ in msgs:
        assert validate(topic, msg) == [], (topic, msg)
    seen = {t for t, _, _ in msgs}
    assert {POSE, OBS_BLE, TRACK, TARGET, COVERAGE, THERMAL} <= seen <= {POSE, OBS_BLE, TRACK, TARGET, COVERAGE, THERMAL, VISION}


def test_pose_is_marked_simulated(out):
    _, _, msgs = out
    assert all(m["src"] == "sim" for t, m, _ in msgs if t == POSE)


def test_only_coverage_is_retained(out):
    _, _, msgs = out
    assert all(retain == (t == COVERAGE) for t, _, retain in msgs)


def test_pins_never_change_status_on_their_own(out):
    # The drone never decides: only the ranger acks, investigates, clears or confirms.
    _, _, msgs = out
    pins = [m for t, m, _ in msgs if t == TARGET]
    assert pins and all(m["status"] == "new" and m["state"] != "confirmed" for m in pins)


def test_team_phone_is_with_drone_and_never_pinned(out):
    _, _, msgs = out
    tracks = {}
    for t, m, _ in msgs:
        if t == TRACK:
            tracks[m["track"]] = m
    drone = [m for m in tracks.values() if m["with_drone"]]
    assert len(drone) == 1
    assert drone[0]["track"] not in {m["track"] for t, m, _ in msgs if t == TARGET}


def test_every_hidden_phone_gets_pinned(out):
    profile, cfg, msgs = out
    last = {}
    for t, m, _ in msgs:
        if t == TARGET:
            last[m["pin"]] = m
    hidden = [p for p in cfg["sim"]["phones"] if "x" in p]
    a = cfg["locate"]["area_m"]
    if a:  # phones outside the sweep box (park: the Cadillac South Ridge hiker) are for trail pathing only
        hidden = [p for p in hidden if a[0] <= p["x"] <= a[2] and a[1] <= p["y"] <= a[3]]
    assert len(last) == len(hidden)
    assert all(m["state"] == "pinned" for m in last.values()), {k: m["state"] for k, m in last.items()}
    for m in last.values():  # the cheating estimate stays near a real phone
        assert min(((m["x"] - p["x"]) ** 2 + (m["y"] - p["y"]) ** 2) ** 0.5 for p in hidden) <= m["r95"] * 1.5


def test_coverage_grows(out):
    _, _, msgs = out
    pct = [m["pct"] for t, m, _ in msgs if t == COVERAGE]
    assert pct == sorted(pct) and pct[-1] > 0.5


def test_only_filters_topics():
    _, msgs = run("indoor", seconds=30, only={"pose", "ble"})
    assert {t for t, _, _ in msgs} == {POSE, OBS_BLE}
