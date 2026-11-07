# AFTERGLOW × Lost & Found: software and hardware integration handoff

**What we're building:** a sensing pod strapped under an FPV drone. It hears the Bluetooth beacons that lost, dead or switched-off phones and AirTags keep sending, and pins where they are on a park map. It then sends that pin to the ranger's laptop and ATAK phone over LoRa, with no Wi-Fi or cell needed. The camera (with person detection on the AI HAT+), thermal and radar help a human confirm. **The drone never decides: the planner proposes, and the ranger approves every pin and every leg.**

Everything runs on the Raspberry Pi 5 in the pod. Programs talk over MQTT topics on the Pi. Only a 16-byte alert leaves the pod.

## Read in this order

1. **`HARDWARE.md`**: every device, which port or address it's on, and how software reaches it. Includes the pin map, Pi setup and the gotchas we already know.
2. **`CONTRACTS.md`**: the MQTT topics and JSON shapes, the ESP32 serial lines, the 16-byte LoRa alert and the ATAK mapping. Agree on it at kickoff.
3. **`MODULES.md`**: who builds which module, which tier, the integration checkpoints by hour, and how to start without hardware.
4. `wiring/`: the wiring diagram, pod layout, our actual Pi labelled pin by pin, the pin table as CSV, and the full interactive wiring page (`wiring_and_build.html`, open it in a browser).
5. `docs/drone_build_plan.md`: offline copy of the build doc's drone plan (decisions, parts, stages, schedule, risks).

## What's in the folder

```
README.md            start here
HARDWARE.md          devices, ports, pins, Pi setup, gotchas
CONTRACTS.md         topics, message formats, serial lines, LoRa alert, ATAK
MODULES.md           owners, tiers, checkpoints, working without hardware
wiring/              wiring_diagram.jpg, pod_layout.jpg, pi_header_labelled.jpg, pins.csv, wiring_and_build.html
pi/                  setup_pi.sh, config.txt.append, udev rules, Mosquitto config, systemd service
firmware/README.md   what the ESP32 boards must send (and the Serial0 gotcha)
code/
  afterglow.toml     shared settings: origin, ports, rules (identical on pod and laptop)
  afterglow/         contracts.py, alert.py (16-byte pack/unpack), geo.py, bus.py,
                     bridge.py and position.py (tier 1, working starters)
  tools/check_hw.py  PASS/FAIL for every piece of pod hardware
  tools/fake_bus.py  fake drone + hidden phones on the bus, for work before hardware
  tests/             pytest: contracts, alert packing, NMEA, address hashing (13 tests)
docs/                drone_build_plan.md
```

## First hour

**Hardware side (Utility), on the Pi:**
```
bash pi/setup_pi.sh                     # packages, config.txt, venv; then add PSU_MAX_CURRENT=5000 and reboot
cd code && .venv/bin/python tools/check_hw.py
.venv/bin/python -m afterglow.bridge    # ESP32 lines → ag/obs/*
.venv/bin/python -m afterglow.position  # GPS → ag/pose
mosquitto_sub -v -t 'ag/#'
```

**Software side, on a laptop, before the hardware is ready:**
```
cd code && python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements-laptop.txt
python3 -m pytest -q
python3 tools/fake_bus.py --speed 5     # needs a local Mosquitto; or --print
```

## Still open (decide or measure Saturday)

- **FPV details:** model, prop size, battery, flight-controller firmware, control link (ELRS 2.4 GHz or 900 MHz). These set flight time and which radio test matters.
- **Mission origin** (`afterglow.toml`): set it once and copy it to the laptop.
- **Range numbers** from ME 2's test. They replace the placeholder distances for `localized` and `pinned`, the lane spacing and `fake_bus.py`'s signal model.
- **Off-trail distance** for day patrol (`offtrail_m`, 30 m placeholder). Ask Greg.
- **Alert version:** v1 (decimetres) for the taped indoor park, v2 (metres) outdoors. Both sides decode either.

## Links (private until the owner shares them with you)

- Build doc, "Drone build plan (Nov 7)" tab: https://claude.ai/artifact/Ev2HU2inb5zBq77eHsJLZX
- Wiring & Build page, live version of `wiring/wiring_and_build.html`: https://claude.ai/artifact/9dFkxY68jSQ399Thspfx1U
