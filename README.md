# AFTERGLOW

**A search-assist payload for drones that hears lost phones, including ones that are switched off or dead, pins them on a park map, and gets each pin to rangers over LoRa with no cell or Wi-Fi.**

Built in 26 hours by Team 30 at the CodeMetalForge hackathon, 7–8 Nov 2026.

> **The one rule: the drone never decides.** The planner proposes, and the ranger approves every pin and every flight leg. No code path can confirm a pin or accept a leg by itself.

## The problem

When someone goes missing in a park, rangers have to narrow a whole drainage down to one spot, fast. In an Oregon study of about 3,300 search subjects, search time was the only factor that predicted survival ([Adams et al. 2007](<https://www.wemjournal.org/article/S1080-6032(07)70218-1/fulltext>)).

The lost person's phone is often the best clue, but by the time a search starts it's usually out of coverage, dead or switched off. Existing drone tools need the phone to be powered on.

AFTERGLOW goes after that phone anyway. Even switched off, an iPhone 11 or newer keeps sending a Find My Bluetooth beacon for up to 24 hours, and for about 5 hours after its battery dies ([Macworld](https://www.macworld.com/article/2154248/how-to-find-a-missing-iphone-or-ipad-when-its-nearly-out-of-power.html)). Android phones in Google Find Hub or Samsung lost mode do something similar.

## What it does

1. **Hears.** A passive Bluetooth scanner on the pod picks out lost-device beacons from Apple Find My (separated devices), Google Find Hub and Samsung lost mode. It reads only each beacon's type marker and signal strength.
2. **Locates.** The tracker combines signal strength with where the pod was to estimate each beacon's position on a grid, with an honest 95% radius. It keeps following a beacon when its key rotates.
3. **Flags.** The ranger's rules decide which beacons become pins, depending on the mode:
   - **Day patrol:** a beacon farther off-trail than the set distance, heard on 2 or more passes.
   - **Night sweep:** any beacon outside the campgrounds.
   - **Active search:** every lost-device beacon.
4. **Sends.** Each pin leaves the pod as a 16-byte LoRa alert. A software-defined radio (SDR) on the ranger's laptop receives it, and the pin shows on the operator screen and on field teams' phones (ATAK/iTAK).
5. **Helps confirm.** The ranger checks each pin with a live camera view and real thermal temperatures. An SOS Wi-Fi page lets the person answer "hurt? can walk? how many?", and each answer lands on the pin.
6. **Plans.** The planner proposes homing passes over a pin, a search grid or a trail patrol. Once the ranger accepts a leg, an observer reads its heading and distance to the pilot.

## How it works

```
                         THE POD (Raspberry Pi 5)                                     THE RANGER'S LAPTOP
 BLE scanner (ESP32) ──► bridge ──► tracker ──► geofence ──► lora_out ──► RFM95W ~~~ 915 MHz LoRa ~~~► ADALM-PLUTO SDR
 Wi-Fi + SOS page    ──►  (hashes     (grid       (ranger      (16-byte                                   │
                          addresses)   estimate)   rules, pins) alerts)                                    ▼
 IMU / GPS ──► position ──► ag/pose          ▲                                       lora_rx ──► cot_out ──► ATAK / iTAK phones
 thermal camera ──► thermal ──► hot spot ────┘                                            │
 camera ──► live view                       planner ──► proposed legs                     ▼
                                                                                 operator TV (dashboard) ◄── ranger's clicks
```

- **On the pod:** each box is its own Python process on a Raspberry Pi 5, and they talk over MQTT topics. Only the 16-byte alert leaves the pod over LoRa.
- **Over Wi-Fi:** when the pod is in Wi-Fi range, the laptop's dashboard also reads the pod's MQTT broker for live pictures, tracks and coverage.
- **Contracts:** every message format is in [`docs/CONTRACTS.md`](docs/CONTRACTS.md) and checked by `contracts.validate()` in the tests.

## Safety and privacy by design

- **The ranger decides everything.** Geofence accepts Confirm only on a pin that's being investigated. The planner only proposes. The dashboard only relays clicks and never acts on its own. Tests cover each of these.
- **Passive listening only.** The scanners never transmit. The only transmitters are the LoRa alert and the SOS page. LoRa has an off switch (`lora_off`) that survives a restart, and the SOS page starts switched off. The pilot's control link always wins.
- **No identities.** The pod replaces raw Bluetooth and Wi-Fi addresses with a salted hash and picks a new salt for every search. It never decodes beacon payloads, and it never writes an address to disk, a log or the screen.
- **Minimal radio content.** The plain LoRa alert carries a pin's position, class and status, never an address or ID.
- **The case stays home.** The missing person's details (name, age, description) stay on the ranger's laptop and never go on the bus or over LoRa.

## What's real and what's simulated

We built and tested the payload on its own: the drones available at the hackathon were too small to carry it. It's designed to strap under a larger drone.

| Part | Status | Evidence |
|---|---|---|
| Bluetooth scanner → bus | ✅ On hardware | Real Find My beacons reach the bus as hashed IDs. In a crowded building it heard about 1.5 Find My beacons/s against about 240/s of other Apple traffic, so the split works. |
| LoRa link, pod → laptop | ✅ On hardware | Pod RFM95W → ADALM-PLUTO SDR (GNU Radio + gr-lora_sdr) → decoded alerts. Pins and heartbeat received; `lora_off`/`lora_on` work; packets from 6 other teams heard and dropped. |
| Thermal (HTI HT-203U) | ✅ On hardware | Reads real temperatures from the raw 16-bit frames. A hand 50 cm away reads hot and a wall doesn't. |
| Camera (Camera Module 3) | ✅ On hardware | Live view to the dashboard. |
| SOS Wi-Fi page | ✅ On hardware | A phone joins `SOS-RESCUE`, the page pops up, and the answer reaches the bus. |
| Wi-Fi listener | ✅ On hardware | Hashed probe IDs on channels 1, 6 and 11. |
| Pod services | ✅ On hardware | All 9 pod modules start at boot under systemd, and a health module reports each part. |
| Position | ✅ On hardware | GPS (NEO-F10N) sends NMEA, but gets no fix indoors. The indoor demo uses the IMU step count along a measured line. |
| Tracking accuracy | 🟡 Simulated | Real tracker on simulated beacons, 20 runs indoors: one track per phone through every key rotation, worst error 1.5 m. Not yet measured with real beacons. |
| Park-scale mission (Acadia) | 🟡 Simulated | The full mission on real OpenStreetMap trails: sweep, a false alarm, homing, a found person, rescue route. Badged SIMULATED on screen. |
| ATAK / iTAK markers | 🟡 Built, tested in code | Cursor-on-Target markers plus a small TAK server for iTAK; tests check the XML. |
| Flight | ⬜ Not flown | Payload only (see above). |
| Person detection (AI HAT+) | ⬜ Stretch, not built | The live camera view lets a human check instead. |

The code has 378 automated tests (`pytest`), and every module runs on fake data with no hardware.

## Try it (laptop, no hardware)

You need Python 3.11 or newer.

```
cd code
python3 -m venv .venv && .venv/bin/pip install -r requirements-laptop.txt
.venv/bin/python -m pytest -q                                          # 378 tests
.venv/bin/python tools/local_stack.py --config park.toml --feeds       # the whole system, simulated, no broker
```

Open http://localhost:8081 and click **Send out**. The drone sweeps a box at Acadia; about a minute later a false signal pings, and about a minute after that the missing person's phone. Walk it through Investigate → Confirm, and watch the planner propose legs for you to accept.

To run the whole LoRa path with no radio and no broker:

```
.venv/bin/python tools/fake_bus.py --print --duration 120 | .venv/bin/python -m afterglow.lora_out --dry-run \
  | .venv/bin/python -m afterglow.lora_rx --dry-run | .venv/bin/python -m afterglow.cot_out --dry-run
```

The live demo with the real pod is in [`docs/DEMO.md`](docs/DEMO.md).

## What's in the repo

```
code/afterglow/     one Python module per process (python -m afterglow.<name>)
  pod:              bridge, position, tracker, locate, geofence, planner, thermal, camera, lora_out, health
  laptop:           lora_rx, cot_out, dashboard (+ case: the missing-person case, laptop only)
  web/              the operator TV (Preact + htm, MapLibre; vendored, no CDN, no build step)
code/afterglow.toml the live indoor demo (60 State St); code/park.toml is the Acadia simulation
code/tools/         fake_bus, local_stack, replay, check_hw (on the Pi), pluto_rx (the SDR receiver)
code/tests/         pytest
firmware/           ESP32 sketches: BLE scanner, Wi-Fi listener + SOS page
pi/                 Pi setup, udev rules, Mosquitto config, systemd unit
tak/                ATAK/iTAK add-on: field teams' phones ↔ the operator TV
simulator/          TrailSAR: a browser what-if of whole missions in nine real parks (all simulated)
docs/               CONTRACTS, HARDWARE, TV, DEMO and the original build plan
```

## What's next

- **Fly it.** Strap it under a larger drone, then add an autopilot (INAV or ArduPilot) that flies the planner's legs, still one ranger approval per leg.
- **Measure.** Run a range test and blind passes with real beacons to set the signal model and the radii.
- **Person detection** on the AI HAT+, to point the ranger at likely people in the camera view.
- **More drones on one map:** the contracts already allow a `drone` field.
- **Trailhead Bluetooth tags** for children who don't carry a phone.

## Team

Dillon Smith, Rohan Sarkar, Birinder Bachhal, Lucas Marotta.

Licensed under Apache 2.0 ([`LICENSE`](LICENSE)). Map data © OpenStreetMap contributors (ODbL).

---

## For the team

- [`TODO.md`](TODO.md) is the phased plan.
- [`docs/HARDWARE.md`](docs/HARDWARE.md) has parts, ports, pins and Pi setup.
- [`docs/CONTRACTS.md`](docs/CONTRACTS.md) is the source of truth for anything that crosses a module boundary.
- [`docs/MODULES.md`](docs/MODULES.md) lists owners and checkpoints, and [`docs/TV.md`](docs/TV.md) covers the operator TV.
- [`docs/drone_build_plan.md`](docs/drone_build_plan.md) is the original build doc. Its parts list is out of date.
- [`docs/wiring/`](docs/wiring/): only `pins.csv` is current.
- `CLAUDE.md` holds the instructions for Claude Code.
