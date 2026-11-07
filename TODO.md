# AFTERGLOW TODO

Hour 0 is Sat 7 Nov 10:00. Tier 1 is due by hour 12 (Sat 22:00), the freeze is at hour 22 (Sun 08:00) and submission is due by hour 26 (Sun 12:00).

- Owners follow `docs/MODULES.md`: **SW** is Software, **UT** is Utility, and **ME1** and **ME2** are the mechanical leads.
- Tick items as they land. If a milestone slips by more than an hour, cut from the bottom of the tiers. Never push the freeze.
- Checkpoints I1–I9 are defined in `docs/MODULES.md`.

---

## Phase 0: Housekeeping and kickoff (hour 0–1, 10:00–11:00)

- [x] Move the handoff folder up to the repo root; add `.gitignore`, `CLAUDE.md` and this TODO.
- [x] Fix `requirements-laptop.txt`, which was missing `pynmea2`, so the tests couldn't even import on a laptop.
- [x] Set up the laptop venv. All 13 tests pass.
- [x] Push to the team GitHub repo, https://github.com/CodeMetalForge-Hackathon/Team-30-AFTERGLOW (private). Teammates clone it, and the Pi clones it to `/home/pi/afterglow`.
- [x] Install Mosquitto on the laptop (`brew install mosquitto`). Run `fake_bus.py --speed 5` and watch it with `mosquitto_sub -v -t 'ag/#'`. It runs as a `brew services` service, localhost only.
- [x] Settle these contract gaps at kickoff. Edit `contracts.py` and `docs/CONTRACTS.md` together. **Tell the team.**
  - [x] **`ag/target` gets `state` and `last_s`**, which geofence copies from the track. Only the ranger's Confirm sets `confirmed`.
  - [x] **SOS goes through geofence**, onto the investigating pin, or an SOS-only `T0` pin. **Battery** is `ag/sys` `batt_pct`, `null` for now, and goes out as 255.
  - [x] **New retained `ag/coverage` topic** from locate. Its settings are in the new `[locate]` config table.
  - [x] **Images:** dashboard.py serves `live/` and `snaps/` on port 8080, and thermal.py and person.py just write files.
- [x] Decide the dashboard stack. **Locked:**
  - **Server:** `dashboard.py` on Python's built-in `ThreadingHTTPServer`, port 8080. It subscribes to `ag/#`, keeps the latest message for each topic and each pin, and streams them to the browser with Server-Sent Events (`/api/events`). On every reconnect it resends the full state first. Buttons POST to `/api/ctrl` and `/api/mode`; the server stamps `t`, runs `validate()` and publishes. It also serves `live/`, `snaps/` and the map, converted to local metres once with `geo.py`.
  - **Front end:** `code/afterglow/web/` holds `index.html` and `app.js`. Panels use Preact + htm, and the map uses Leaflet in local metres (`CRS.Simple`). There is no build step and no CDN: the libraries are saved in `web/vendor/`.
  - **No new pip packages** on the Pi or the laptop.
  - **Room to grow:** MJPEG live streams from the same server, a `--broker` flag so the dashboard can run on the laptop, and an optional `drone` field once there's a second drone.
- [x] Download Preact + htm (htm's `preact/standalone` bundle) and Leaflet 1.9.4 into `code/afterglow/web/vendor/` **while there's internet**. Pin exact versions. Saved as `vendor/htm-3.1.1/` and `vendor/leaflet-1.9.4/`; usage and hashes are in `vendor/README.md`.
- [x] Create `code/data/trails.geojson` and `code/data/zones.geojson` for the taped indoor park. Units: lon/lat (the GeoJSON standard, converted with `geo.to_xy` on load). `tools/make_indoor_map.py` generates them from the origin and waypoints; rerun it after changing either.
- [x] Set `origin_lat` and `origin_lon` in `afterglow.toml`; indoors, that's the point taped waypoint 0 maps to. Keep the file identical on the pod and the laptop. It's set to Acadia for now; switch it to the venue if the ATAK markers should appear there.
- [x] ~~Set the private Meshtastic channel on every board.~~ **Dropped:** the LoRa radios are two bare RFM95Ws, not Meshtastic boards, so there's no channel key. `lora_rx.py` filters by node address instead. `tools/setup_lora.py` is gone, and `code/lora_channel.key` can be deleted.
- [x] Reconcile the repo with Rohan's hardware reference (`docs/AFTERGLOW Hardware.pdf`, Nov 7): HARDWARE.md, CONTRACTS.md, firmware/README.md, `pins.csv`, the config, `config.txt.append`, `check_hw.py`. `docs/wiring/` (the page and diagrams) is still out of date.
  - **Contract changes, tell the team:**
    - the LoRa link is RFM95W ↔ XIAO #3, with no Meshtastic and no acks;
    - the new laptop-only topic `ag/alert`;
    - the XIAO UART moves to `Serial1` on D9/D10;
    - `findmy` means separated only (`4C 00 12 19`), and `4C 00 12 02` is `apple_other`;
    - new config tables `[lora]` and `[i2c]`, and `[serial] gps = ""`.
- [x] ~~Record the FPV details.~~ **Decided:** the available drones are too small to carry the pod. We build and demo the payload on its own and pitch it as ready to fly once we have a larger drone. Steps that mention the drone (I7, the demo script, the on-drone GPS test) need rewording for a payload-only demo.

## Phase 1: Bring-up and first data (hours 0–3, until 13:00, checkpoints I1–I5)

**Hardware (UT)**
- [ ] Image the Pi, run `bash pi/setup_pi.sh` and reboot (no `PSU_MAX_CURRENT`: it's a 3 A power bank). `check_hw.py` passes for every connected part. **(I1)**
- [ ] Copy the ESP32 sketches (scanner, wifi_listener, sos_page) from the plan doc into `firmware/`. They aren't in the repo. Each must print on `Serial1.begin(921600, SERIAL_8N1, D9, D10)`, not `Serial` (see `firmware/README.md`). The scanner sends `findmy` only for `4C 00 12 19`.
- [ ] OMNI streams `ble` lines, and a real `findmy` beacon reaches `ag/obs/ble` through `bridge.py`. **(I2)** Check the separated/near split on our AirTag and a powered-off iPhone.
- [ ] Put the radar's serial number in `pi/99-afterglow.rules` so `/dev/radar` exists.
- [ ] **LoRa link (I4):**
  - [ ] Solder the spring antennas to both RFM95Ws, and wire the pod radio to SPI1 and the other to XIAO #3 (`docs/HARDWARE.md`).
  - [ ] Flash XIAO #3 with `firmware/lora_rx/lora_rx.ino` (Library Manager: **LoRa** by Sandeep Mistry).
  - [ ] Laptop: `.venv/bin/python -m afterglow.lora_rx --print` logs "radio settings match the config".
  - [ ] Pi: `check_hw.py --only lora` passes, and the heartbeat (`"kind":4`) shows up on the laptop.
- [ ] ~~GPS NMEA by a window (I5).~~ **Blocked:** we have only the ANN-MB5 antenna, no receiver. Ask the hardware desk for any u-blox board with a UART; if one turns up, wire it to the reserved pins, set `gps = "/dev/ttyAMA2"` and run `check_hw.py --only gps`. Until then, position comes from waypoint taps.
- [ ] If the Pi user isn't `pi` or the clone isn't at `/home/pi/afterglow`, fix `User=` and the paths in `pi/systemd/afterglow@.service`.

**Software (SW), on the fake bus: done** (reviewed and pushed Sat 7 Nov)
- [x] Dashboard skeleton (`dashboard.py` + `afterglow/web/`): the event stream with its full-state resend, a Leaflet map with trails and zones, live pose and raw observations, all running on the fake bus. **(I3: pins and coverage move, checked in both profiles.)**
  - The badge (LIVE, SIMULATED or REPLAY) comes from the pose's `src`. The park map carries the OSM credit.
  - Ages use the latest pose's `t`, not the browser clock. Using the newest `t` overall broke: a retained message from a 40× fake run sat hours in the future.
  - Run it with `python -m afterglow.dashboard [--config park.toml] [--broker host]` and open `http://localhost:8080`.
- [x] `tools/replay.py`: replay a `mosquitto_sub -v` log into the same topics with the original timing. It's the 3 a.m. debugging tool and the demo backup.
  - It marks the pose `replay` and moves `t` to now.
  - It shrinks pauses longer than 10 s, and `--topics` replays only the raw input.
  - It skips `ag/ctrl` and `ag/mode` unless you pass `--with-ctrl`, because a recorded Confirm shouldn't be made again unasked.
- [x] **Two config profiles.** Pick one with `--config` or `AFTERGLOW_CONFIG`; `tests/test_parkmap.py` fails if their keys drift apart.
  - **Demo**, `afterglow.toml`: the taped indoor park and real pod data. Now has indoor-scale placeholders: `offtrail_m` 3, `detect_m` 4, and a new `[track]` table with the localized and pinned radii.
  - **Park**, `park.toml`: realistic view at Blackwoods Campground, Acadia, using real OSM trails and roads (`data/park_*.geojson`, made by `tools/make_park_map.py`; picture in `docs/maps/park_map.png`). Laptop only.
- [x] Sim stub: `fake_bus.py` follows the profile's new `[sim]` table (path, hidden phones, RSSI model). It walks the waypoint loop indoors and flies lanes in the park. It also fakes `ag/track`, `ag/target` and a retained `ag/coverage`, so pins and coverage move for I3. Use `--only pose,ble` once the real modules land. Its tracker cheats (it knows the true positions), so never take accuracy numbers from it.
- [x] **Contract change, tell the team:** `ag/pose` `src` can now be `sim`, and `validate()` checks `src`. The dashboard badges `sim` and `replay` data.
- [x] Phase 1 review fixes, each reproduced in a browser first:
  - an armed Confirm no longer carries over when you pick another pin (it took one click);
  - `/api/ctrl` and `/api/mode` take JSON only, so another web page can't click for the ranger;
  - the Heard list keeps adding devices past 300 (it used to freeze);
  - turning Coverage off keeps the Probability heatmap.
- [x] **Contract change, tell the team:**
  - `ag/mode` is now **retained** (`contracts.RETAINED`), so a restarted geofence or a second dashboard knows the mode at once. With no mode yet, geofence assumes patrol.
  - geofence accepts only the allowed pin status changes; above all, **Confirm only while a pin is investigating** (CONTRACTS.md, "Pin states and priority").
  - `fake_bus.py` deletes its retained `ag/coverage` when it stops, so a fake grid doesn't leak into the next run or profile.
- [x] `geofence.py` geometry: distance to the nearest trail and point-in-zone, with tests. It's in `afterglow/parkmap.py` (`ParkMap.load(cfg)`, `dist_to_trail`, `zone_at`, `bounds`, `to_json`), because the dashboard and the fake bus use it too.

## Phase 2: Tier 1 core pipeline (hours 3–12, until 22:00, checkpoints I6 and I7)

The modules are listed roughly in data-flow order, and each one feeds the next. Write tests that check every message with `validate()`.

- [x] **`tracker.py` (SW)** reads `ag/obs/*` and `ag/pose` and writes `ag/track` and `ag/pass` (CONTRACTS.md, "Tracks"):
  - a grid fit of the `[track]` RSSI model gives `x`, `y` and an honest `r95`; state follows `r95`;
  - follows key rotation by time and signal strength, and refuses an unclear match (a duplicate track beats merging two beacons);
  - `with_drone` for beacons that stay loud while the pod moves; `baseline` for beacons heard during the baseline; `new_search` clears;
  - confidence `c`; each finished pass on `ag/pass`;
  - on the fake bus (20 seeds, 33 min indoors): exactly one track per phone through every rotation, worst error 1.5 m. Live through Mosquitto too.
  - **Contract change, tell the team:** `ag/track` gains optional `baseline` and `c`; `ag/pass` now comes from the tracker, with optional `n`; geofence must never pin `with_drone` or `baseline` tracks. New `[track]` keys (pass gap, rotation, `with_drone`, RSSI model) in both profiles.
  - Fixed in `bus.py`: a module that subscribed while connecting could lose paho's thread and go deaf.
  - Known limit, park sim only: a key that rotates while the pod is away starts a new track, so a phone can split. Fix later by merging tracks whose estimates agree (needs a contract change for the merged-away track).
  - Set the `[track]` RSSI model (`rssi_p0`, `rssi_n`, `rssi_sigma`) from ME 2's range test.
  - [ ] Set `with_drone_rssi` (both profiles) from the range test: measure our phone strapped to the pod and a phone at carry height (3 m), and pick a value between them. At -55, a phone much louder than the model, right under the path, gets marked `with_drone` (grey, never pinned) while the pod is near it. Then let `fake_bus.py`'s team phone read as loud as 0.5 m (it stops at 1 m now), or its with_drone test breaks. Until then, the baseline covers it (Phase 4).
- [x] **`locate.py` (SW)**, now just the grids, since the tracker posts `ag/pass` and `r95` (CONTRACTS.md, "Coverage grid"):
  - keeps the probability grid (from `ag/track`: `x`, `y`, `r95`, `c`; skip `with_drone` and `baseline`). Each track is a blob that peaks at 255 × `c`; where blobs overlap, the higher one wins. A track not updated for `stale_s` (30) drops out;
  - the coverage overlay from `ag/pose`, joining each drone's poses in a straight line, so tapped waypoints leave no gaps;
  - publishes `ag/coverage` about once a second, **retained**. `new_search` clears both grids;
  - `fake_bus.py`'s stand-in coverage is now the real `Locate` fed the fake tracks, so the two grids can't drift apart;
  - tested on the fake pod through the real tracker, in both profiles and live through Mosquitto.
  - **Contract change, tell the team:** locate acts on `new_search`. There are new `[locate]` keys `area_m` (the box the grids cover; empty means the park zone) and `stale_s`. `ag/pose` has a new optional `drone` (which drone sent it; missing means the one pod). In `park.toml`, `area_m` is the search box (80 × 80 cells); the whole park would be 221 × 211, too big to send every second. `[sim] area_m` is now empty there, meaning the same box.
  - Later, maybe: lower `p` in cells already covered with nothing heard (a proper search map); keep coverage through a locate restart.
- [x] **`geofence.py` (SW)** writes `ag/target` (CONTRACTS.md, "How geofence fills a pin"):
  - applies the `day_offtrail`, `night_outside_camp` and `search` rules according to `ag/mode` (retained, so it's there at start-up; patrol until the first click). Investigate keeps the last other mode's rule;
  - sets priority 1–4 and assigns pin IDs (`P1`, `P2`, …);
  - updates the pin status on `ack`, `investigate`, `clear` and `confirm`, using only the allowed changes in CONTRACTS.md. **Confirm only while the pin is investigating:** the dashboard greys the button, but its server doesn't check, so geofence is the guard. Tested for every command from every status;
  - never pins a `with_drone` or `baseline` track;
  - copies `state`, `last_s` and `c` from the track, and sets `state` to `confirmed` only on Confirm;
  - attaches `ag/sos` answers to the investigating pin, or opens an SOS-only `T0` pin at the pod;
  - pins stay once made (only the ranger clears), so a rule must hold for `pin_hold_s` (15 s), and day and night wait until the track is localized with its 95% circle clear of campgrounds;
  - saves pins to `runs/pins_*.json`, so a restart doesn't reuse `P1`; unlinks a track that comes back with none of its ids (tracker restart);
  - on the fake pod through the real tracker (20 seeds, 20 min indoors): patrol pins only the dead iPhone in 19 of 20, night ignores the campground tag in 20 of 20, search pins all three in 19 of 20. The misses are early tracker estimates: one about 9 m out while claiming ±3.6 m, and one team phone marked `with_drone` only after 46 s.
  - **Contract change, tell the team:** `day_offtrail` now skips campgrounds (otherwise the campground tag gets pinned in patrol and demo step 8 can't show night ignoring it). New `[rules]` keys `pin_hold_s`, `pins_file`, `pins_max_age_min` in both profiles. `fake_bus.py` now sends `off_trail_m` `null`, not 9999, when there's no trail.
  - Park sim only: the tracker's key-rotation splits give some phones 2–3 pins, and `airtag_pack` (39 m off trail) is estimated at 20–29 m, under the 30 m threshold, so patrol often misses it. Both are tracker limits (see above).
  - Tier 2: set `flags.thermal`, `flags.camera` from `ag/thermal` and `ag/vision` (it carries `track`) on the investigating pin.
- [ ] **`dashboard.py` (SW)**. Most of this landed with the Phase 1 skeleton:
  - [x] pins with Acknowledge, Investigate, Clear and Confirm buttons. Confirm needs two clicks and only works while the pin is being investigated. Each button shows "waiting for geofence" until the status changes, and warns if it never does;
  - [x] a mode switch for patrol, night, investigate and search;
  - [ ] Baseline and New search buttons. New search should also drop old tracks and pins from the dashboard's state (`dashboard.py` and `store.js`), since the tracker forgets them. Baseline tracks already show grey;
  - [x] waypoint taps for the indoor park, on the map and as a 0–7 strip in the Pod panel;
  - [x] the coverage and probability overlays, and pod health from `ag/sys`;
  - [ ] the thermal and camera panel (it reloads the `live/` images about once a second);
  - [x] serves `live/` and `snaps/` on port 8080;
  - [x] takes a `--broker` flag (it overrides `[mqtt] host`), so it also runs on the laptop. Each instance has its own MQTT client id, so the Pi's and the laptop's can share a broker;
  - [ ] draw `ag/plan` legs, with Accept and Reject (`accept_leg`, `reject_leg`), once `planner.py` exists.
- [ ] **`lora_out.py` (UT)** sends `ag/target` through `alert.encode` from the RFM95W (`radio.open_pod_radio(cfg["lora"])`, then `rfm.send(pkt)`):
  - every 5 s per active pin, and at once when a pin's state changes or an SOS arrives;
  - P1 first; no acks, because the repeats cover lost packets;
  - a heartbeat;
  - obeys `lora_off` and `lora_on`;
  - ages `last_s` between repeats, takes the battery from `ag/sys`, and sends `rule: "sos"` pins as type 2.
- [x] **`lora_rx.py` (SW, laptop):** XIAO #3's lines → `ag/alert` on the laptop's broker. It drops other teams' packets and checks the radio settings at start-up. Tested on fake lines; I4 proves it on the radios.
- [ ] **`cot_out.py` (SW, laptop)** reads `ag/alert` and sends CoT with pytak to `239.2.3.1:6969`:
  - callsign `P1 T1`, remarks text, and colour by priority;
  - the pod shown as a friendly unit;
  - the 95% circle, if ATAK draws it. Check the marker type in ATAK;
  - **fallback:** a flag to read `ag/target` from the Pi's broker over Wi-Fi instead, so ATAK still works in the demo if the radio dies (there's no spare XIAO).
- [ ] **`thermal.py` view (UT)**: MLX90640 at about 4 Hz, written to `live/thermal.png` (temp file, then rename), and the warmest spot on `ag/thermal`.
- [ ] **health (UT)**: `ag/sys` from `vcgencmd`, ports, disk, GPS fix and LoRa, plus `batt_pct: null`. Reuse the checks in `check_hw.py`.
- [ ] Put ME 2's range numbers in by hour 7: the localized and pinned radii, the lane spacing and `fake_bus.py`'s RSSI model.
- [ ] **(I6, hour 7, 17:00):** carried along the taped trail, a pin lands within 5 m and shows its off-trail distance. Save a screenshot and the measured error.
- [ ] **(I7, hour 12, 22:00):** with the closed pod on the drone and props off, run two passes → pin → Investigate → thermal and camera panel → ATAK marker over LoRa. **Record the backup video.**

## Phase 3: Tier 2 (hours 12–22, until the 08:00 freeze, checkpoint I8 at 02:00)

- [ ] **`planner.py` (SW)** writes `ag/plan`:
  - on `investigate`, homing legs: one crossing pass, then a shrinking orbit;
  - a search grid spaced by the measured range;
  - patrol routes along the trails;
  - acts on `accept_leg` and `reject_leg`.
  The dashboard draws each leg with the heading and distance the observer reads to the pilot.
- [ ] **`person.py` (SW)** writes `ag/vision` with a snapshot (`snaps/<t>.jpg`) and sets the pin's `camera` flag:
  - writes `live/camera.jpg` about once a second for the panel, because only one process can open the camera;
  - uses a precompiled Hailo YOLO model and keeps only the person class;
  - tiles each 4608×2592 frame into overlapping 640×640 pieces (about 28 tiles, about 1 fps) and merges the boxes;
  - runs the CPU colour-anomaly check;
  - is tuned for recall, and runs only during Investigate if heat or power fails.
- [ ] **Dashboard live feeds (SW):** MJPEG streams of the camera and thermal views from `dashboard.py`, in place of the once-a-second image reload. `person.py` also writes a smaller preview more often, because it runs at only about 1 fps while it tiles frames.
- [ ] **`thermal.py` flag (UT):** flag hot spots only from a low hover, under 8 m, using the pose's `z`.
- [ ] **`sim.py` (SW):**
  - a park-scale simulator over Acadia, using a trails GeoJSON (done: the `park.toml` profile and `data/park_*.geojson`);
  - simulated phones using the measured range;
  - runs day patrol, night sweep and active search, and draws the coverage map.
- [ ] **sos_page firmware (UT):** an open `SOS-RESCUE` AP with a captive page that sends `sos` lines and obeys `sos_on` and `sos_off`.
  - Optional, from the hardware reference (contract change first): a custom `msg` on `sos_on`, and a "phone joined the SOS network" event, which is a strong sign someone is there.
- [ ] **`position.py`:** add IMU roll and pitch from the BNO086 at `[i2c] imu_addr` (`0x4B`), with RST on GPIO23 passed as `reset=`.
- [ ] **(I8, hour 16, 02:00) evidence:**
  - the range numbers;
  - 10 blind passes, with the median and worst error;
  - the night-mode false-alarm count;
  - planner homing legs on the dashboard.
  These go on the evidence slide.

## Phase 4: Demo hardening and freeze (hours 16–26)

- [ ] Load the best run's replay and test it, as the backup if the hardware fails.
- [ ] Demo setup:
  - a 10-minute baseline at the demo spot, with any team trackers on the pod, so they show grey instead of relying on `with_drone`;
  - a team iPhone switched off at least 20 minutes early and hidden;
  - the travel router on, with the pod and the laptop on it, never the venue Wi-Fi: the dashboard has no login, so anyone on the same network could click;
  - everything charged.
- [ ] Two clean end-to-end rehearsals of the demo script in `docs/drone_build_plan.md`.
- [ ] **Hour 22 (Sun 08:00): freeze.** After it, only fixes that block the demo.
- [ ] Submit before Sun 12:00.

---

## Stretch goals (only if ahead, most valuable first)

- [ ] **`radar.py` (tier 3, UT):** MR60BHA2 breathing and heart rate on `ag/radar`, landed within 1.5 m. Feeds the alert's `br` byte and the `radar` flag.
- [ ] **CalTopo export (tier 3, SW):** pins and coverage as GeoJSON, plus a live marker through CalTopo's position API.
- [ ] **LoRa fallback view (tier 3, SW):** once the laptop loses Wi-Fi to the Pi, the dashboard on the laptop shows pins from `lora_rx.py`, without feeds.
- [ ] **Live outdoor position test (tier 3, UT):** a GPS fix with the pod on the drone, logged against a phone's GPS.
- [ ] **Fine-tuned person detector:**
  - train YOLO on HERIDAL on a GPU or Colab and export it to ONNX;
  - compile it with Hailo's Dataflow Compiler, using at least 1,024 calibration images.
  It took one developer a full weekend, so try it only with a GPU and spare time.
- [ ] **Radar pole mount.**
- [ ] **Pod battery reading (UT):** a voltage divider from the LiPo into a XIAO analog pin, so `ag/sys` `batt_pct` stops being `null`.

### Beyond the hackathon

These are the next steps from the build plan's "Not building" list.

- An autopilot (INAV or ArduPilot) that flies the planner's legs.
- Several drones on one dashboard: an optional `drone` field in the contracts, and the dashboard on the laptop listening to every pod.
- Trailhead Bluetooth tags for families, for the no-phone child case.
- Docking and charging stations for routine patrols.
