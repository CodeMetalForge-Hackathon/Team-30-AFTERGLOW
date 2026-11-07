"""Trail pathing for the TV dashboard: trails.py (ranking, routes), case.py (the open case),
the dashboard's /api/case, and the fake pod flying the case's trail."""
import json
import math
import random
import sys
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

from afterglow import config, trails
from afterglow.case import CaseStore
from afterglow.contracts import POSE, validate
from afterglow.dashboard import Commands, State, make_handler, make_meta
from afterglow.parkmap import ParkMap

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
from fake_bus import FakePod  # noqa: E402

PARK = config.load(config.DEFAULT.parent / "park.toml")
DEMO = config.load()


@pytest.fixture(scope="module")
def park_pm():
    return ParkMap.load(PARK)


# ---------- trails.py ----------

def test_start_point_is_the_car_park_or_the_entrance():
    xy, label = trails.start_point(PARK, "Gorham Mountain lot")
    assert label == "Gorham Mountain lot" and xy == [1150.0, 820.0]
    xy, label = trails.start_point(PARK, None)
    assert label == "Park entrance" and xy == PARK["search"]["entrance_xy"]
    assert trails.start_point(PARK, "No such lot")[1] == "Park entrance"


def test_ranking_prefers_popular_trails_near_the_car(park_pm):
    near_gorham = trails.rank(PARK, park_pm, [1150.0, 820.0])
    assert [r["name"] for r in near_gorham[:2]] == ["Ocean Path", "Gorham Mountain Trail"]
    near_quarry = trails.rank(PARK, park_pm, [150.0, 110.0])
    assert near_quarry[1]["name"] == "Quarry Trail"  # the nearby trail climbs the list
    assert near_quarry[1]["dist_m"] < 50
    for r in near_gorham:
        assert set(r) == {"name", "pct", "dist_m", "length_m", "pop"}
    assert sum(r["pct"] for r in trails.rank(PARK, park_pm, [1150.0, 820.0], top=100)) in range(98, 103)


def test_route_is_one_line_starting_at_the_end_nearer_the_start(park_pm):
    start = [1080.0, -250.0]  # Otter Point lot, by Ocean Path's south end
    pts = trails.route(park_pm, "Ocean Path", start)
    assert len(pts) > 50
    assert math.dist(pts[0], start) < math.dist(pts[-1], start)
    assert 2000 < trails.length(pts) < 3000  # the pieces joined, scraps left out
    assert all(math.dist(a, b) <= trails.MAX_GAP_M for a, b in zip(pts, pts[1:]))
    assert trails.route(park_pm, "No such trail", start) == []


def test_progress_along_a_route():
    pts = [[0, 0], [100, 0], [100, 50]]
    assert trails.progress(pts, 50, 3) == (50.0, 150.0, 3.0)
    along, total, off = trails.progress(pts, 104, 25)
    assert (along, total, off) == (125.0, 150.0, 4.0)


# ---------- case.py ----------

def test_case_open_update_close_and_persist(tmp_path, park_pm):
    path = tmp_path / "case.json"
    cs = CaseStore(PARK, park_pm, path=path)
    assert cs.view()["case"] is None and cs.view()["ranking"] == []
    seen = []
    cs.listeners.append(seen.append)
    problems, v = cs.open({"name": " Sam ", "age": 34, "details": "red jacket", "carrying": "iphone",
                           "car_park": "Gorham Mountain lot"})
    assert problems == []
    assert v["case"]["name"] == "Sam" and v["case"]["age"] == "34" and v["case"]["expect_cls"] == "findmy"
    assert v["start"]["label"] == "Gorham Mountain lot"
    assert v["trail"] == v["ranking"][0]["name"] == "Ocean Path" and len(v["route"]) > 50
    assert json.loads(path.read_text())["name"] == "Sam"
    # the ranger picks another trail; the rest of the case stays
    problems, v = cs.open({"trail": "Gorham Mountain Trail"})
    assert problems == [] and v["trail"] == "Gorham Mountain Trail" and v["case"]["name"] == "Sam"
    # a restart reads it back
    assert CaseStore(PARK, park_pm, path=path).view()["case"]["trail"] == "Gorham Mountain Trail"
    v = cs.close()
    assert v["case"] is None and not path.exists()
    assert len(seen) == 3 and seen[-1]["case"] is None


def test_case_rejects_bad_input(tmp_path, park_pm):
    cs = CaseStore(PARK, park_pm, path=tmp_path / "c.json")
    assert cs.open({"age": "3"})[0] == ["a case needs a name"]
    problems, _ = cs.open({"name": "x" * 81, "carrying": "pigeon", "car_park": "Nowhere", "trail": "Nope", "details": ["a"]})
    assert len(problems) == 5
    assert cs.view()["case"] is None


def test_case_never_reaches_the_bus(tmp_path, park_pm):
    """Personal details stay on the laptop: CaseStore has no bus, and nothing it returns is a topic."""
    cs = CaseStore(PARK, park_pm, path=tmp_path / "c.json")
    assert not hasattr(cs, "bus")
    _, v = cs.open({"name": "Sam"})
    assert set(v) == {"case", "start", "ranking", "trail", "route"}


# ---------- dashboard /api/case ----------

@pytest.fixture
def server(tmp_path, park_pm):
    meta = make_meta(PARK, park_pm)
    state = State(meta["trail_step_m"])
    cmds = Commands(lambda: None, PARK["waypoints"])
    cases = CaseStore(PARK, park_pm, path=tmp_path / "case.json")
    cases.listeners.append(lambda v: state.broadcast("case", v))
    srv = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(state, cmds, meta, {"live": tmp_path, "snaps": tmp_path}, cases))
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}", state, meta
    srv.shutdown()
    srv.server_close()


def call(url, body=None):
    req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def test_api_case_round_trip(server):
    base, state, meta = server
    assert [cp["name"] for cp in meta["search"]["car_parks"]][0] == "Gorham Mountain lot"
    assert call(f"{base}/api/case")[1]["case"] is None
    q = state.subscribe()
    code, out = call(f"{base}/api/case", {"name": "Sam", "car_park": "Otter Point lot", "carrying": "android"})
    assert code == 200 and out["ok"] and out["case"]["expect_cls"] == "findhub"
    assert out["start"]["label"] == "Otter Point lot" and out["ranking"][0]["name"] == "Ocean Path"
    events = [q.get_nowait() for _ in range(q.qsize())]
    assert any(ev == "case" and json.loads(data)["case"]["name"] == "Sam" for ev, data in events)
    assert call(f"{base}/api/case")[1]["case"]["name"] == "Sam"
    code, out = call(f"{base}/api/case", {"car_park": "Nowhere"})
    assert code == 400 and not out["ok"]
    code, out = call(f"{base}/api/case/close", {})
    assert code == 200 and out["case"] is None


def test_page_is_served(server):
    base, _, _ = server
    with urllib.request.urlopen(f"{base}/tv.html", timeout=5) as r:
        assert r.status == 200 and b"tv.js" in r.read()


# ---------- the fake pod flies the case's trail in "search" ----------

def test_fake_pod_flies_the_trail_only_in_search(park_pm):
    pod = FakePod(PARK, park_pm, random.Random(1), only={"pose"})
    start = [1080.0, -250.0]
    route = trails.route(park_pm, "Ocean Path", start)
    pod.set_route(route)
    run = pod.run(0)
    poses = lambda n: [m for _, m, _ in (next(run) for _ in range(n))]  # noqa: E731
    lanes = poses(50)
    x0, y0, x1, y1 = pod.area
    assert all(x0 - 1 <= m["x"] <= x1 + 1 and y0 - 1 <= m["y"] <= y1 + 1 for m in lanes)  # still on its lanes
    pod.on_mode({"t": 0, "mode": "search"})
    flown = poses(5 * 400)  # 400 s at 5 Hz
    for m in flown:
        assert validate(POSE, m) == []
    steps = [math.dist((a["x"], a["y"]), (b["x"], b["y"])) for a, b in zip([lanes[-1]] + flown, flown)]
    assert max(steps) < PARK["sim"]["speed_mps"] / PARK["pose"]["publish_hz"] + 0.5  # no jumps: it flies over
    on_trail = [m for m in flown if trails.progress(route, m["x"], m["y"])[2] < 1.0]
    assert len(on_trail) > len(flown) / 2  # most of the time on the trail itself
    pod.on_mode({"t": 0, "mode": "patrol"})
    back = poses(5 * 400)
    assert trails.progress(route, back[-1]["x"], back[-1]["y"])[2] > 1.0  # back to the lanes


def test_demo_profile_has_trail_pathing_too(tmp_path):
    cs = CaseStore(DEMO, ParkMap.load(DEMO), path=tmp_path / "c.json")
    _, v = cs.open({"name": "Test", "car_park": "Car park A"})
    assert v["trail"] == "Taped trail" and len(v["route"]) >= 2
