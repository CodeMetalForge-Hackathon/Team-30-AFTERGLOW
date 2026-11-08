"""geofence.py, the live demo's RSSI rule ([rules] rssi_window): a Find My beacon heard in the window
becomes a pin where the pod is; stronger readings move it in; the ranger still decides everything."""
from afterglow import config
from afterglow.contracts import CTRL, OBS_BLE, POSE, TARGET, TRACK, validate
from afterglow.geofence import Geofence
from afterglow.parkmap import ParkMap

T0 = 1_731_000_000_000
CFG = config.load(config.DEFAULT)
PM = ParkMap.load(CFG)


class Collect:
    def __init__(self):
        self.msgs = []

    def publish(self, topic, obj, retain=False):
        self.msgs.append((topic, dict(obj)))


def make(cfg=CFG):
    bus = Collect()
    return Geofence(cfg, bus, PM), bus


def pose(g, x, y, t):
    g.feed(POSE, {"t": t, "x": x, "y": y, "z": 3.0, "src": "imu"})


def ble(g, rssi, t, oid="a1b2c3d4", cls="findmy"):
    g.feed(OBS_BLE, {"t": t, "src": "omni", "id": oid, "cls": cls, "rssi": rssi})


def targets(bus):
    out = [m for topic, m in bus.msgs if topic == TARGET]
    for m in out:
        assert validate(TARGET, m) == []
    return out


def test_demo_profile_has_the_window_and_park_has_it_off():
    assert CFG["rules"]["rssi_window"] == [-75, -60] and CFG["rules"]["rssi_cls"] == ["findmy"]
    park = config.load(config.DEFAULT.parent / "park.toml")
    assert park["rules"]["rssi_window"] == []
    assert Geofence(park, Collect(), ParkMap.load(park)).rssi_window is None


def test_two_readings_in_the_window_make_a_pin_where_the_pod_is():
    g, bus = make()
    pose(g, 4.0, 1.0, T0)
    ble(g, -70, T0 + 100)
    assert targets(bus) == []  # one reading is not enough
    ble(g, -68, T0 + 2100)
    (p,) = targets(bus)
    assert (p["pin"], p["rule"], p["status"], p["cls"], p["track"]) == ("P1", "rssi", "new", "findmy", "T0")
    assert (p["x"], p["y"], p["rssi"]) == (4.0, 1.0, -68)
    assert 5 < p["r95"] < 12 and 0.5 <= p["c"] <= 1
    assert "id" not in p and "a1b2c3d4" not in str(p)  # never the beacon's id on the bus


def test_outside_the_window_never_pins():
    g, bus = make()
    pose(g, 0.0, 0.0, T0)
    for i in range(6):
        ble(g, -80, T0 + i * 2000)            # too far
        ble(g, -45, T0 + i * 2000, oid="ours")  # riding on the pod
        ble(g, -65, T0 + i * 2000, oid="pix", cls="findhub")  # not Find My
        ble(g, -65, T0 + i * 2000, oid="aa", cls="apple_other")
    assert targets(bus) == []


def test_a_weak_reading_between_resets_the_count():
    g, bus = make()
    pose(g, 0.0, 0.0, T0)
    ble(g, -70, T0)
    ble(g, -82, T0 + 2000)
    ble(g, -70, T0 + 4000)
    assert targets(bus) == []
    ble(g, -70, T0 + 6000)
    assert len(targets(bus)) == 1


def test_no_pose_no_pin():
    g, bus = make()
    ble(g, -65, T0)
    ble(g, -65, T0 + 2000)
    assert targets(bus) == []


def test_stronger_moves_the_pin_in_and_shrinks_it_weaker_does_not():
    g, bus = make()
    pose(g, 1.0, 0.0, T0)
    ble(g, -74, T0)
    ble(g, -74, T0 + 2000)
    first = targets(bus)[-1]
    pose(g, 6.0, 2.0, T0 + 4000)
    ble(g, -58, T0 + 4100)  # above the window: closer, still the same pin
    moved = targets(bus)[-1]
    assert moved["pin"] == "P1" and (moved["x"], moved["y"]) == (6.0, 2.0) and moved["r95"] < first["r95"]
    assert moved["prio"] <= first["prio"]
    pose(g, 9.0, 0.0, T0 + 6000)
    ble(g, -70, T0 + 6100)  # weaker: heard, but the pin stays where it was loudest
    last = targets(bus)[-1]
    assert (last["x"], last["y"], last["r95"], last["rssi"]) == (6.0, 2.0, moved["r95"], -70)
    assert len({m["pin"] for m in targets(bus)}) == 1


def test_cleared_pin_freezes_and_its_beacon_never_pins_again():
    g, bus = make()
    pose(g, 0.0, 0.0, T0)
    ble(g, -66, T0)
    ble(g, -66, T0 + 2000)
    g.feed(CTRL, {"t": T0 + 3000, "cmd": "clear", "pin": "P1"})
    n = len(bus.msgs)
    for i in range(5):
        ble(g, -62, T0 + 5000 + i * 2000)
    assert len(bus.msgs) == n
    ble(g, -66, T0 + 20000, oid="other")
    ble(g, -66, T0 + 22000, oid="other")
    assert targets(bus)[-1]["pin"] == "P2"


def test_never_confirms_by_itself():
    g, bus = make()
    pose(g, 0.0, 0.0, T0)
    for i in range(20):
        ble(g, -61, T0 + i * 1000)
    assert {m["status"] for m in targets(bus)} == {"new"}


def test_track_rules_skip_find_my_while_on():
    g, bus = make(dict(CFG, rules=dict(CFG["rules"], pin_hold_s=0)))
    g.feed(TRACK, {"t": T0, "track": "T1", "ids": ["x"], "cls": "findmy", "x": 2.0, "y": 6.0, "r95": 1.5,
                   "state": "pinned", "passes": 2, "last_s": 0, "c": 0.9})
    assert targets(bus) == []
    g.feed(TRACK, {"t": T0, "track": "T2", "ids": ["y"], "cls": "findhub", "x": 2.0, "y": 6.0, "r95": 1.5,
                   "state": "pinned", "passes": 2, "last_s": 0, "c": 0.9})
    assert [m["track"] for m in targets(bus)] == ["T2"]


def test_links_survive_a_restart(tmp_path):
    f = tmp_path / "pins.json"
    bus = Collect()
    g = Geofence(CFG, bus, PM, pins_file=f)
    pose(g, 0.0, 0.0, T0)
    ble(g, -66, T0)
    ble(g, -66, T0 + 2000)
    g2 = Geofence(CFG, Collect(), PM, pins_file=f)
    g2.restore()
    assert g2.rssi_links == {"a1b2c3d4": "P1"}
    pose(g2, 3.0, 0.0, T0 + 3000)
    ble(g2, -66, T0 + 4000)
    ble(g2, -66, T0 + 6000)
    assert g2.n == 1  # the same beacon: still P1
