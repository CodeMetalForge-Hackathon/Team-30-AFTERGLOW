# AFTERGLOW

A search-assist sensing pod strapped under an FPV drone. It hears the Bluetooth beacons that lost, dead or switched-off phones and AirTags keep sending, and pins where they are on a park map. It then sends that pin to the ranger's laptop and ATAK phone over LoRa, with no Wi-Fi or cell needed. The camera (with person detection on the AI HAT+), thermal and radar help a human confirm. **The drone never decides: the planner proposes, and the ranger approves every pin and every leg.**

Everything runs on the Raspberry Pi 5 in the pod. Programs talk over MQTT topics on the Pi. Only a 16-byte alert leaves the pod.

## Read in this order

1. [`TODO.md`](TODO.md): the phased plan for the hackathon. Tick items as they land.
2. [`docs/HARDWARE.md`](docs/HARDWARE.md): every device, its port or address, how software reaches it, Pi setup and known gotchas.
3. [`docs/CONTRACTS.md`](docs/CONTRACTS.md): MQTT topics and JSON shapes, ESP32 serial lines, the 16-byte LoRa alert and the ATAK mapping. The source of truth for anything that crosses a module boundary.
4. [`docs/MODULES.md`](docs/MODULES.md): who builds which module, tiers, integration checkpoints, and how to start without hardware.
5. [`docs/drone_build_plan.md`](docs/drone_build_plan.md): offline copy of the build doc (decisions, parts, schedule, demo script, risks).
6. [`docs/wiring/`](docs/wiring/): wiring diagram, pod layout, our Pi labelled pin by pin, `pins.csv`, and the interactive `wiring_and_build.html` (open it in a browser).

## Layout

```
README.md            start here
TODO.md              phased plan, ticked as we go
CLAUDE.md            instructions for Claude Code
docs/                CONTRACTS.md, HARDWARE.md, MODULES.md, drone_build_plan.md
  maps/              indoor_map.png (the taped park)
  wiring/            diagrams, pins.csv, wiring_and_build.html
code/
  afterglow.toml     shared settings: origin, ports, rules (identical on pod and laptop)
  afterglow/         contracts.py, alert.py, geo.py, bus.py, config.py,
                     bridge.py and position.py (tier 1, working)
  data/              trails.geojson, zones.geojson
  tools/             check_hw.py, fake_bus.py, make_indoor_map.py, draw_map.py
  tests/             pytest
pi/                  setup_pi.sh, config.txt.append, udev rules, Mosquitto config, systemd service
firmware/README.md   what the ESP32 boards must send (and the Serial0 gotcha)
```

## Quick start

**Laptop** (software, before the hardware is ready). Needs Mosquitto: `brew install mosquitto && brew services start mosquitto`.
```
cd code && python3 -m venv .venv && .venv/bin/pip install -r requirements-laptop.txt
.venv/bin/python -m pytest -q
.venv/bin/python tools/fake_bus.py --speed 5     # fake drone + hidden phones; or --print without a broker
mosquitto_sub -v -t 'ag/#'                       # watch the bus
```

**Pi** (clone to `/home/pi/afterglow`):
```
bash pi/setup_pi.sh                     # packages, config.txt, venv; then add PSU_MAX_CURRENT=5000 and reboot
cd code && .venv/bin/python tools/check_hw.py
.venv/bin/python -m afterglow.bridge    # ESP32 lines → ag/obs/*
.venv/bin/python -m afterglow.position  # GPS → ag/pose
```

## Still open

- **FPV details:** model, prop size, battery, flight-controller firmware, control link (ELRS 2.4 GHz or 900 MHz).
- **Range numbers** from ME 2's test. They replace the placeholders for `localized` and `pinned`, the lane spacing, `[locate]` and `fake_bus.py`'s signal model.
- **Off-trail distance** (`offtrail_m`, 30 m placeholder). The taped park is only 9 m wide, so the indoor demo needs about 2–3 m.
- **Alert version:** v1 (decimetres) for the taped indoor park, v2 (metres) outdoors. Both sides decode either.

## Links (private until the owner shares them with you)

- Build doc, "Drone build plan (Nov 7)" tab: https://claude.ai/artifact/Ev2HU2inb5zBq77eHsJLZX
- Wiring & Build page, live version of `docs/wiring/wiring_and_build.html`: https://claude.ai/artifact/9dFkxY68jSQ399Thspfx1U
