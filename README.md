# AFTERGLOW

A search-assist sensing pod strapped under an FPV drone. It hears the Bluetooth beacons that lost, dead or switched-off phones and AirTags keep sending, and pins where they are on a park map. It then sends that pin to the ranger's laptop and ATAK phone over LoRa, with no Wi-Fi or cell needed. The camera (with person detection on the AI HAT+), thermal and radar help a human confirm. **The drone never decides: the planner proposes, and the ranger approves every pin and every leg.**

Everything runs on the Raspberry Pi 5 in the pod. Programs talk over MQTT topics on the Pi. Only a 16-byte alert leaves the pod.

## Read in this order

1. [`TODO.md`](TODO.md): the phased plan for the hackathon. Tick items as they land.
2. [`docs/HARDWARE.md`](docs/HARDWARE.md): every device, its port or address, how software reaches it, Pi setup and known gotchas. It comes from Rohan's hardware reference ([`docs/AFTERGLOW Hardware.pdf`](<docs/AFTERGLOW Hardware.pdf>)), which lists the parts we actually have.
3. [`docs/CONTRACTS.md`](docs/CONTRACTS.md): MQTT topics and JSON shapes, ESP32 serial lines, the 16-byte LoRa alert and the ATAK mapping. The source of truth for anything that crosses a module boundary.
4. [`docs/MODULES.md`](docs/MODULES.md): who builds which module, tiers, integration checkpoints, and how to start without hardware.
5. [`docs/drone_build_plan.md`](docs/drone_build_plan.md): offline copy of the build doc (decisions, parts, schedule, demo script, risks).
6. [`docs/wiring/`](docs/wiring/): `pins.csv` is current. The wiring diagram, pod layout and `wiring_and_build.html` are **out of date** (they still show Meshtastic, the BNO085 and a GPS module); use the pin map in HARDWARE.md.

## Layout

```
README.md            start here
TODO.md              phased plan, ticked as we go
CLAUDE.md            instructions for Claude Code
docs/                CONTRACTS.md, HARDWARE.md, MODULES.md, drone_build_plan.md
  maps/              indoor_map.png (the taped park), park_map.png (the realistic park view)
  wiring/            diagrams, pins.csv, wiring_and_build.html
code/
  afterglow.toml     DEMO profile: the taped indoor park, real pod (identical on pod and laptop)
  park.toml          PARK profile: realistic view on real Acadia trails, laptop only, simulated
  afterglow/         contracts.py, alert.py, geo.py, bus.py, config.py, parkmap.py,
                     bridge.py, position.py, radio.py, lora_rx.py and dashboard.py (tier 1, working)
    web/             the dashboard front end (Preact + htm, Leaflet; vendored, no CDN)
  data/              trails.geojson, zones.geojson (indoor); park_trails.geojson, park_zones.geojson (OSM)
  tools/             check_hw.py, fake_bus.py, replay.py, make_indoor_map.py, make_park_map.py, draw_map.py
  tests/             pytest
pi/                  setup_pi.sh, config.txt.append, udev rules, Mosquitto config, systemd service
firmware/            README.md: what the ESP32 boards must send (Serial1 on D9/D10); lora_rx/: the laptop radio's sketch
simulator/           TrailSAR mission simulator: the drone's sweep, beacon homing and thermal check in real parks (browser, all simulated)
```

## Quick start

**Laptop** (software, before the hardware is ready). Needs Mosquitto: `brew install mosquitto && brew services start mosquitto`.
```
cd code && python3 -m venv .venv && .venv/bin/pip install -r requirements-laptop.txt
.venv/bin/python -m pytest -q
.venv/bin/python tools/fake_bus.py --speed 5     # fake pod + hidden phones, indoor; or --print without a broker
.venv/bin/python tools/fake_bus.py --config park.toml --speed 10   # the same at park scale
.venv/bin/python -m afterglow.dashboard          # then open http://localhost:8080 (add --config park.toml for the park)
mosquitto_sub -v -t 'ag/#'                       # watch the bus
```

Run the dashboard and the fake bus with the same profile.

**Live map feed.** `web/livemap.js` draws the live bus on a 3D terrain map with labels and a key (pod at height, its hearing radius, where beacons were heard, tracks, pins, coverage). It only draws; the dashboard keeps the buttons. Open `http://localhost:8080/livemap.html`, embed that page, or use the `LiveMap` class (same methods as `map.js`'s `MapView`). See [`docs/LIVEMAP.md`](docs/LIVEMAP.md). **No Mosquitto** (e.g. Windows): `tools/local_stack.py` runs a source, the real tracker and geofence, and the dashboard in one process:
```
.venv/bin/python tools/local_stack.py --config park.toml --speed 10            # fake pod
.venv/bin/python tools/local_stack.py --config park.toml --replay runs/1432.log --loop   # a recorded real run
``` To record a run and play it back, the demo backup:
```
mosquitto_sub -v -t 'ag/#' > runs/$(date +%H%M).log
.venv/bin/python tools/replay.py runs/1432.log --loop
```

**Two profiles.** We don't fly, so there are two views of the same system:
- **Demo**, `afterglow.toml`: the taped indoor park with real pod data. This is what runs live at the demo.
- **Park**, `park.toml`: a realistic view at Blackwoods Campground in Acadia, using real OpenStreetMap trails. It's simulated, laptop only, and badged SIMULATED on the dashboard.

Every module takes `--config`, or set `AFTERGLOW_CONFIG=park.toml`. Both files must have the same keys, which a test checks.

**Pi** (clone to `/home/pi/afterglow`):
```
bash pi/setup_pi.sh                     # packages, config.txt, venv; then reboot
cd code && .venv/bin/python tools/check_hw.py
.venv/bin/python -m afterglow.bridge    # ESP32 lines → ag/obs/*
.venv/bin/python -m afterglow.position  # GPS → ag/pose
```

## Still open

- **Payload only (decided):** our drones are too small to carry the pod, so we demo the payload on its own and pitch it as ready for a larger drone.
- **Range numbers** from ME 2's test. They replace the placeholders in both profiles: `[track]` (localized and pinned radii), `[locate]`, and the `[sim]` lane spacing and signal model.
- **Off-trail distance:** `offtrail_m` is 3 m in `afterglow.toml` (the taped park is only 9 m wide) and 30 m in `park.toml`. Both are placeholders.
- **Alert version:** v1 (decimetres) for the taped indoor park, v2 (metres) outdoors. Both sides decode either.

## Links (private until the owner shares them with you)

- Build doc, "Drone build plan (Nov 7)" tab: https://claude.ai/artifact/Ev2HU2inb5zBq77eHsJLZX
- Wiring & Build page, live version of `docs/wiring/wiring_and_build.html`: https://claude.ai/artifact/9dFkxY68jSQ399Thspfx1U
