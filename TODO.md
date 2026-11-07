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
- [ ] Download Preact + htm (htm's `preact/standalone` bundle) and Leaflet 1.9.4 into `code/afterglow/web/vendor/` **while there's internet**. Pin exact versions.
- [x] Create `code/data/trails.geojson` and `code/data/zones.geojson` for the taped indoor park. Units: lon/lat (the GeoJSON standard, converted with `geo.to_xy` on load). `tools/make_indoor_map.py` generates them from the origin and waypoints; rerun it after changing either.
- [x] Set `origin_lat` and `origin_lon` in `afterglow.toml`; indoors, that's the point taped waypoint 0 maps to. Keep the file identical on the pod and the laptop. It's set to Acadia for now; switch it to the venue if the ATAK markers should appear there.
- [ ] Set the private Meshtastic channel name and key on every board by hour 1. **Keep the key out of the repo.**
  - [x] Team key made: `code/lora_channel.key` on Dillon's laptop (git-ignored). Teammates get it by direct message.
  - [ ] Pod board: plug into the laptop, `.venv/bin/python tools/setup_lora.py --port /dev/cu.usbmodem…`, all PASS.
  - [ ] Board #2 (laptop): same command, all PASS.
- [ ] Record the FPV details: model, props, battery, flight-controller firmware and control link (ELRS 2.4 GHz or 900 MHz). The control link decides which radio coexistence test matters.

## Phase 1: Bring-up and first data (hours 0–3, until 13:00, checkpoints I1–I5)

**Hardware (UT)**
- [ ] Image the Pi, run `bash pi/setup_pi.sh`, add `PSU_MAX_CURRENT=5000` and reboot. `check_hw.py` passes for every connected part. **(I1)**
- [ ] Copy the ESP32 sketches (scanner, wifi_listener, sos_page) from the plan doc into `firmware/`. They aren't in the repo. Each must print to `Serial0`, not `Serial`.
- [ ] OMNI streams `ble` lines, and a real `findmy` beacon reaches `ag/obs/ble` through `bridge.py`. **(I2)**
- [ ] Put the real serial numbers in `pi/99-afterglow.rules` so `/dev/lora` and `/dev/radar` exist.
- [ ] A Meshtastic message crosses to board #2. **(I4)** **First** run `tools/setup_lora.py` on both boards (the hour-1 item above) so I4 tests the private channel, not the default one.
- [ ] The GPS gives NMEA by a window and `check_hw.py --only gps` passes. Set `gps_baud` to what it reports. **(I5)**
- [ ] If the Pi user isn't `pi` or the clone isn't at `/home/pi/afterglow`, fix `User=` and the paths in `pi/systemd/afterglow@.service`.

**Software (SW), on the fake bus**
- [ ] Dashboard skeleton (`dashboard.py` + `afterglow/web/`): the event stream with its full-state resend, a Leaflet map with trails and zones, live pose and raw observations, all running on the fake bus. **(I3)**
- [ ] `geofence.py` geometry: distance to the nearest trail and point-in-zone, with tests.
- [ ] `tools/replay.py`: replay a `mosquitto_sub -v` log into the same topics with the original timing. It's the 3 a.m. debugging tool and the demo backup.
- [ ] Sim stub: extend `fake_bus.py`, or start `sim.py`, enough to drive the dashboard.

## Phase 2: Tier 1 core pipeline (hours 3–12, until 22:00, checkpoints I6 and I7)

The modules are listed roughly in data-flow order, and each one feeds the next. Write tests that check every message with `validate()`.

- [ ] **`tracker.py` (SW)** reads `ag/obs/*` and `ag/pose` and writes `ag/track`:
  - merges sightings across passes;
  - follows the 15-minute Find My key rotation by place and time (the `ids` list);
  - sets the `with_drone` filter for beacons that stay loud wherever the drone goes (`fake_bus.py`'s team phone);
  - turns beacons seen between `baseline_start` and `baseline_stop` grey, and clears on `new_search`;
  - assigns the state (heard, localized or pinned, with radii from config) and the confidence `c`.
- [ ] **locate: `bearing.py` + map (SW)**:
  - finds each pass's RSSI peak and publishes `ag/pass` (`sharp` = dB above the pass median);
  - keeps the probability grid;
  - computes the 95% radius (`r95`) and the coverage overlay;
  - publishes `ag/coverage` about once a second, **retained**.
- [ ] **`geofence.py` (SW)** writes `ag/target`:
  - applies the `day_offtrail`, `night_outside_camp` and `search` rules according to `ag/mode`;
  - sets priority 1–4 and assigns pin IDs (`P1`, `P2`, …);
  - updates the pin status on `ack`, `investigate`, `clear` and `confirm`;
  - copies `state` and `last_s` from the track, and sets `state` to `confirmed` only on Confirm;
  - attaches `ag/sos` answers to the investigating pin, or opens an SOS-only `T0` pin at the pod.
- [ ] **`dashboard.py` (SW)**:
  - pins with Acknowledge, Investigate, Clear and Confirm buttons;
  - a mode switch for patrol, night, investigate and search;
  - Baseline and New search buttons, plus waypoint taps for the indoor park;
  - the coverage overlay, pod health from `ag/sys`, and the thermal and camera panel (it reloads the `live/` images about once a second);
  - serves `live/` and `snaps/` on port 8080;
  - takes a `--broker` flag (it overrides `[mqtt] host`), so it also runs on the laptop.
- [ ] **`lora_out.py` (UT)** sends `ag/target` through `alert.encode` as Meshtastic `PRIVATE_APP`:
  - every 5 s per active pin, and at once when a pin's state changes or an SOS arrives;
  - P1 first, with `wantAck` for P1 and P2;
  - a heartbeat;
  - obeys `lora_off` and `lora_on`;
  - ages `last_s` between repeats, takes the battery from `ag/sys`, and sends `rule: "sos"` pins as type 2.
- [ ] **`lora_rx.py` + `cot_out.py` (SW, laptop)** decode the alert and send CoT with pytak to `239.2.3.1:6969`:
  - callsign `P1 T1`, remarks text, and colour by priority;
  - the pod shown as a friendly unit;
  - the 95% circle, if ATAK draws it. Check the marker type in ATAK.
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
  - a park-scale simulator over Acadia, using a trails GeoJSON (an OSM export; grab it while there's internet);
  - simulated phones using the measured range;
  - runs day patrol, night sweep and active search, and draws the coverage map.
- [ ] **sos_page firmware (UT):** an open `SOS-RESCUE` AP with a captive page that sends `sos` lines and obeys `sos_on` and `sos_off`.
- [ ] **`position.py`:** add IMU roll and pitch from the BNO085.
- [ ] **(I8, hour 16, 02:00) evidence:**
  - the range numbers;
  - 10 blind passes, with the median and worst error;
  - the night-mode false-alarm count;
  - planner homing legs on the dashboard.
  These go on the evidence slide.

## Phase 4: Demo hardening and freeze (hours 16–26)

- [ ] Load the best run's replay and test it, as the backup if the hardware fails.
- [ ] Demo setup:
  - a 10-minute baseline at the demo spot;
  - a team iPhone switched off at least 20 minutes early and hidden;
  - the travel router on;
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
