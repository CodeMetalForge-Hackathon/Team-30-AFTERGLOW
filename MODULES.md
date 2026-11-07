# Modules, owners and build order

- **Tier 1** must run end to end by **hour 12** (Saturday 22:00).
- **Tier 2** lands by the **hour-22 freeze** (Sunday 08:00).
- **Tier 3** happens only if we're ahead.
- If a milestone slips by more than an hour, cut from the bottom of the tiers. Don't push the freeze.

Hour 0 is Saturday 10:00. Hard cutoff is Sunday 12:00.

## Who builds what

✅ = starter code is in `code/` and tested.

| Module | Runs on | Reads | Writes | Tier | Owner | Starter |
|---|---|---|---|---|---|---|
| scanner (firmware) | OMNI board | BLE radio | serial `ble` lines | 1 | Utility | plan doc + `firmware/README.md` |
| wifi_listener (firmware) | WIFI board | Wi-Fi radio | serial `wifi` lines | 1 | Utility | plan doc + `firmware/README.md` |
| `bridge.py` | Pi | ttyAMA0, ttyAMA3, `ag/ctrl` | `ag/obs/ble`, `ag/obs/wifi`, `ag/sos` | 1 | Utility | ✅ |
| `position.py` | Pi | ttyAMA2 NMEA, `ag/ctrl` waypoint | `ag/pose` | 1 | Utility | ✅ (IMU roll/pitch still to add) |
| `tracker.py` | Pi | `ag/obs/*`, `ag/pose`, `ag/ctrl` | `ag/track` | 1 | Software | |
| locate (`bearing.py` + map) | Pi | `ag/obs/ble`, `ag/pose` | `ag/pass`, `ag/coverage` (retained) | 1 | Software | |
| `geofence.py` | Pi | `ag/track`, trails and zones GeoJSON, `ag/mode`, `ag/ctrl`, `ag/sos`, `ag/pose` | `ag/target` | 1 | Software | |
| `dashboard.py` | Pi, viewed on the laptop | everything; serves the images on port 8080 | `ag/ctrl`, `ag/mode` | 1 | Software | |
| `lora_out.py` | Pi | `ag/target`, `ag/sys`, `ag/ctrl` | 16-byte alerts over Meshtastic | 1 | Utility | ✅ `afterglow/alert.py` |
| `lora_rx.py`, `cot_out.py` | Laptop | Meshtastic | CoT to ATAK | 1 | Software | ✅ `alert.py`, `geo.py` |
| `thermal.py` | Pi | MLX90640 | `ag/thermal` + `live/thermal.png` | 1 view, 2 flag | Utility | |
| health | Pi | vcgencmd, ports | `ag/sys` | 1 | Utility | `tools/check_hw.py` has the checks |
| `planner.py` | Pi | `ag/target`, `ag/pose`, `ag/ctrl` | `ag/plan` | 2 | Software | |
| `person.py` | Pi + AI HAT+ | camera | `ag/vision`, `snaps/<t>.jpg`, `live/camera.jpg` | 2 | Software | |
| `sim.py` | Laptop | park map (Acadia) | `ag/pose`, `ag/obs/ble` | 2 | Software | `tools/fake_bus.py` is a small start |
| sos_page (firmware) | WIFI board | Wi-Fi AP | serial `sos` lines | 2 | Utility | plan doc |
| `radar.py` | Pi | radar kit | `ag/radar` | 3 | Utility | |
| CalTopo export | Laptop | `ag/target`, coverage | GeoJSON | 3 | Software | |

What each module must do is in the build doc's Software table and the plan doc. The rules that decide a pin (off-trail distance plus 2 passes by day, outside campgrounds at night, anything during an active search, and ignore beacons that move with the drone) are in `CONTRACTS.md`, "Pin states and priority".

## Integration checkpoints

Each checkpoint is a moment two people's work has to meet. Test it together; don't assume.

| # | When | Checkpoint | Proof |
|---|---|---|---|
| I1 | Hour 2 | Pi imaged, `setup_pi.sh` run, `check_hw.py` passes for every connected part | Screenshot of the check output |
| I2 | Hour 3, first light | A real `findmy` beacon reaches the bus | `mosquitto_sub -v -t 'ag/obs/ble'` shows it |
| I3 | Hour 3 | The dashboard runs on the fake bus or simulator | Pins and the coverage overlay move |
| I4 | Hour 3 | A Meshtastic message crosses to board #2 | `meshtastic --port /dev/lora --sendtext hi` shows on the other board |
| I5 | Hour 3 | NMEA from the GPS (by a window) | `check_hw.py --only gps` passes |
| I6 | Hour 7, first pass | Carried along the taped trail, a pin lands within 5 m and shows its off-trail distance | Dashboard screenshot plus the measured error |
| I7 | Hour 12, core demo | Closed pod on the drone, props off: two passes → pin → Investigate → thermal and camera panel → ATAK marker over LoRa | Backup video recorded |
| I8 | Hour 16, evidence | Range numbers, 10 blind passes, night-mode false-alarm count, planner homing legs | Evidence slide |
| I9 | Hour 22 | Freeze: fixes only | — |

## Working without hardware (hours 0–3)

Hardware bring-up and software start at the same time, so nobody waits.

```
# laptop: install Mosquitto (brew install mosquitto / apt install mosquitto) and run it
cd code
python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements-laptop.txt
python3 tools/fake_bus.py --speed 5          # drone lanes + 3 hidden phones on ag/pose and ag/obs/ble
mosquitto_sub -v -t 'ag/#'                   # watch everything
python3 -m pytest -q                         # contracts, alert packing, NMEA, hashing
```

`fake_bus.py` hides:
- a dead iPhone at (120, 76) m;
- an AirTag at (60, 32) m;
- a team phone that rides on the drone, which `tracker.py`'s "moves with the drone" filter should drop.

Each changes its hashed ID every 15 minutes, like Find My.

## Habits that save the demo

- **Record everything:** `mosquitto_sub -v -t 'ag/#' > runs/$(date +%H%M).log`. Replay into the same topics to debug at 3 a.m. and to keep a backup that shows the real system.
- **Validate:** call `afterglow.contracts.validate(topic, msg)` in tests for everything you publish.
- **Privacy:** never log a raw address. Only `bridge.py` sees them.
- **Shared config:** keep `afterglow.toml` identical on the pod and the laptop, especially the origin.
