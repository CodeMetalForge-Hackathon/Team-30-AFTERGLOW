# AFTERGLOW

A search-assist sensing pod strapped under an FPV drone. It passively hears the Bluetooth beacons that lost, dead or switched-off phones and AirTags keep sending (Apple Find My, Google Find Hub, Samsung lost mode). It pins them on a park map, then sends each pin over LoRa (Meshtastic) to the ranger's laptop and ATAK phone, with no Wi-Fi or cell. A camera with person detection on the AI HAT+, plus thermal and radar, helps a human confirm. Everything on the pod runs on a Raspberry Pi 5.

**Payload only (decided at kickoff):** the drones we have are too small to carry the pod, so we build and demo the payload on its own and pitch it as ready to fly on a larger drone. Don't plan work that needs the pod in the air.

The project is built at a 26-hour hackathon. Hour 0 is Sat 7 Nov 2026 at 10:00 ET, the freeze is at hour 22 (Sun 08:00) and submission is due by hour 26 (Sun 12:00). `TODO.md` holds the phased plan; tick items there as they land.

**How to answer:** keep answers and explanations simple and short. Go into detail only when asked.

**The one rule:** the drone never decides. The planner proposes, and the ranger approves every pin and every leg. No code path may auto-confirm a pin or auto-accept a leg.

## Read first

- `docs/CONTRACTS.md`: topics, JSON shapes, ESP32 serial lines, the 16-byte LoRa alert and the ATAK mapping. It is the source of truth for anything that crosses a module boundary.
- `docs/HARDWARE.md`: devices, ports, pins and known gotchas.
- `docs/MODULES.md`: owners (Software, Utility), tiers and integration checkpoints I1–I9.
- `docs/drone_build_plan.md`: an offline copy of the build doc, with locked decisions, schedule, demo script and risks. If sources conflict, the wiring page (`docs/wiring/wiring_and_build.html`) wins for pins and the build doc wins for decisions.

## Layout

```
code/
  afterglow/            Python package; every module runs as `python -m afterglow.<name>`
    contracts.py        topic names, enums, REQUIRED keys, validate()
    alert.py            16-byte LoRa alert encode/decode (v1 decimetres, v2 metres)
    geo.py              lat/lon <-> local metres around the origin
    bus.py              Bus (paho-mqtt 2.x) and PrintBus (for --dry-run)
    config.py           loads afterglow.toml (env AFTERGLOW_CONFIG overrides the path); resolve() for paths in it
    parkmap.py          trails, roads and zones in metres: dist_to_trail, zone_at, bounds (geofence, dashboard, fake bus)
    bridge.py           ESP32 serial -> ag/obs/ble, ag/obs/wifi, ag/sos (hashes addresses)
    position.py         GPS NMEA or taped waypoints -> ag/pose
  afterglow.toml        DEMO profile (taped indoor park); must be identical on the pod and the laptop
  park.toml             PARK profile (realistic view, real Acadia trails), laptop only; same keys as afterglow.toml
  data/                 trails/zones.geojson (indoor) and park_trails/park_zones.geojson (OSM); all lon/lat
  tools/fake_bus.py     fake pod per the profile's [sim] table, plus stand-in track/target/coverage
  tools/make_park_map.py  data/park_*.geojson from OpenStreetMap (needs internet)
  tools/check_hw.py     PASS/FAIL for each pod part (run on the Pi)
  tools/setup_lora.py   private Meshtastic channel onto a LoRa board; key in lora_channel.key (git-ignored)
  tools/make_indoor_map.py  writes data/*.geojson from the origin and waypoints
  tools/draw_map.py     draws the map files to docs/maps/indoor_map.png
  tests/                pytest
docs/                   CONTRACTS.md, HARDWARE.md, MODULES.md, drone_build_plan.md
  maps/                 map pictures
  wiring/               diagrams, pins.csv, wiring_and_build.html
pi/                     setup_pi.sh, config.txt lines, udev rules, Mosquitto conf, systemd unit
firmware/               what the ESP32 boards must send (the sketches aren't in the repo yet)
```

On the Pi, clone the repo to `/home/pi/afterglow`, because `pi/systemd/afterglow@.service` assumes that path.

## Commands

Run all of these from `code/`:

```
python3 -m venv .venv && .venv/bin/pip install -r requirements-laptop.txt   # laptop setup
.venv/bin/python -m pytest -q                                            # tests
.venv/bin/python tools/fake_bus.py --print | head                        # fake data, no broker
.venv/bin/python tools/fake_bus.py --speed 5                             # fake data to local Mosquitto (demo profile)
.venv/bin/python tools/fake_bus.py --config park.toml --speed 10         # park profile (realistic view)
mosquitto_sub -v -t 'ag/#'                                               # watch the whole bus
.venv/bin/python -m afterglow.bridge --dry-run < lines.txt               # no hardware, no broker
.venv/bin/python -m afterglow.position --dry-run < nmea.txt
.venv/bin/python tools/check_hw.py [--only gps omni]                     # on the Pi only
.venv/bin/python tools/setup_lora.py --port <port> [--check]              # private channel on a LoRa board
```

Anything past `--print` or `--dry-run` needs Mosquitto on the laptop (`brew install mosquitto`).

## Architecture

- Modules are separate processes that talk only over MQTT: Mosquitto on the Pi at `localhost:1883`. Each message is one JSON object, and every topic starts with `ag/`. Only the 16-byte alert leaves the pod.
- `t` is Unix time in milliseconds, stamped on the Pi by `contracts.now_ms()`. The ESP32s keep no clock.
- Positions are in local metres: `x` is east and `y` is north of the mission origin set in `afterglow.toml`. Only `position.py` (inbound) and `cot_out.py` (outbound) convert lat/lon, both through `geo.py`.
- Data flow: bridge → `ag/obs/*`; position → `ag/pose`; tracker → `ag/track`; locate → `ag/pass`, `ag/coverage`; geofence (also reads `ag/sos`) → `ag/target`; lora_out → Meshtastic → lora_rx → cot_out → ATAK. The dashboard writes `ag/ctrl` and `ag/mode`.
- `ag/target` is the one record per pin that the dashboard, the LoRa alert and ATAK all consume. `geofence.py` owns it.

## Conventions

- **Module shape.** Copy the pattern in `bridge.py` and `position.py`:
  - a class whose `handle_*` and `on_ctrl` methods take parsed input and call `bus.publish`;
  - a `main()` with argparse, `--config` and a `--dry-run` that uses `PrintBus`.
  Tests drive the class with a stub bus that collects `(topic, msg)` pairs.
- **Hardware imports.** Import hardware-only libraries (`serial`, `picamera2`, Hailo, `meshtastic`, Adafruit) inside the function that uses them, so the module still imports on a laptop.
- **Contracts.** Change `contracts.py` and `docs/CONTRACTS.md` together, in one commit, and tell the team. Several people build against them in parallel, so don't rename topics or fields casually.
- **Validation.** Every published message must pass `contracts.validate(topic, msg)`. Assert this in tests.
- **LoRa alert.** Use `alert.encode` and `alert.decode`. Never re-type the struct.
- **Profiles.** `afterglow.toml` is the demo (indoor, real pod) and `park.toml` the realistic park view (laptop only, simulated). Every module takes `--config`. A new config key goes in both files.
- **Config.** Load with `afterglow.config.load()`, and open files it names with `config.resolve(cfg, rel)`. Never hard-code ports, thresholds or the origin. The range-dependent numbers (localized and pinned radii, lane spacing, `offtrail_m`) are placeholders until ME 2's range test, so they belong in config.
- **Python version.** Target Python 3.11, which is what Pi OS Bookworm ships, so no 3.12-only syntax. The laptop runs 3.12. The Pi venv uses `--system-site-packages` because picamera2 and Hailo come from apt.
- **Bus behaviour.** `Bus` handlers run on paho's network thread, so keep them fast. `Bus.subscribe` keeps one handler per topic pattern: subscribing to the same pattern again replaces the first handler.
- **USB serial.** Never hard-code `ttyACM0`. Use `/dev/lora`, `/dev/radar` or `/dev/serial/by-id/…`.
- **Test against fake data first.** Every new module should run against `tools/fake_bus.py` before it touches hardware.

## Privacy rules (non-negotiable)

- Never write a raw Bluetooth or Wi-Fi address to disk, a log or the screen. Only `bridge.py` sees raw addresses; it publishes an 8-hex salted hash as `id`, with a new salt on every `new_search`.
- Never decode or decrypt beacon payloads. Read only the type marker and the RSSI.
- The scanners are passive. The SOS Wi-Fi page is the only transmitter and must obey `sos_off`, and `lora_out.py` must obey `lora_off`. The pilot's control link always wins.
- Call it "patrol" or "search-assist", never "surveillance", in UI text, docs and the pitch.
- Never commit the Meshtastic channel key, camera snapshots (`snaps/`) or run logs (`runs/`).

## Hackathon rules

- Tier 1 must run end to end by hour 12 (Sat 22:00). Tier 2 lands by the hour-22 freeze. Tier 3 happens only if the team is ahead.
- If a milestone slips by more than an hour, cut from the bottom of the tiers. Never push the freeze.
- After the freeze, only fixes that block the demo go in.
- Prefer working and demoable over complete.
