# Contracts: how the programs talk to each other

Agree on this file at kickoff and don't change it casually. Several people build against it at once, so a silent change costs hours. If you must change something, change `code/afterglow/contracts.py` and this file in the same commit, and tell everyone.

The topics come from the plan doc's contract table. The drone build (FPV, GPS module, camera person check, park modes) adds a few. Those are marked **new** or **changed**.

## Ground rules

- **Message bus:** Mosquitto on the Pi, `localhost:1883`. Every message is one JSON object (UTF-8). Every topic starts with `ag/`.
- **Time:** `t` is Unix time in milliseconds. The Pi stamps it when a message arrives. The ESP32s keep no clock.
- **Position:** every module works in local metres.
  - `x` is metres east and `y` is metres north of the mission origin (`origin_lat`, `origin_lon` in `afterglow.toml`).
  - Only `position.py` (in) and `cot_out.py` (out) convert to and from latitude and longitude, both using `afterglow/geo.py`.
  - The pod and the laptop must use **the same origin**, so it lives in the shared config file.
- **Indoors** (taped park on the venue floor), the origin is taped waypoint 0. Waypoint coordinates come from the `[waypoints]` table in the config.
- **Device IDs:** `id` is a salted hash of the device address, 8 hex characters. `bridge.py` makes it. The salt changes on every `new_search`.
- **Track IDs:** `"T1"`, `"T2"` and so on, assigned by `tracker.py`. A dashboard pin is an `ag/target` record.

## Privacy rules (non-negotiable)

- Never write a raw Bluetooth or Wi-Fi address to disk, a log or the screen. Only `bridge.py` sees raw addresses, and it hashes them before publishing.
- Never try to decode or decrypt beacon contents. We only read the type marker and the signal strength.
- Scanners listen passively and never transmit. The SOS Wi-Fi page is the only thing that transmits, and it has an off switch (`ag/ctrl` `sos_off`).
- Call it a patrol or search-assist system, never surveillance. A human confirms every pin.

## Topics

| Topic | Posted by | Example | Meaning |
|---|---|---|---|
| `ag/obs/ble` | bridge.py | `{"t":1731000000123,"src":"omni","id":"7f3a9c21","cls":"findmy","rssi":-71}` | One Bluetooth advert heard. `cls` is in the table below |
| `ag/obs/wifi` | bridge.py | `{"t":…,"id":"c01d22aa","rand":true,"rssi":-80,"ch":6}` | One Wi-Fi probe request heard |
| `ag/sos` | bridge.py | `{"t":…,"hurt":true,"walk":false,"count":2,"rssi":-55}` | An answer from the SOS page (tier 2). geofence.py attaches it to a pin; see "SOS answers" below |
| `ag/pose` (**changed**) | position.py | `{"t":…,"x":412.3,"y":-88.0,"z":12.0,"lat":44.3386,"lon":-68.2733,"alt_m":61.2,"course":87.5,"speed_mps":4.1,"fix":1,"sats":14,"src":"gps"}` | Where the pod is. `z` is height above take-off in metres. `src` is `gps`, `waypoint` or `replay`. Optional `roll` and `pitch` (degrees) from the IMU |
| `ag/pass` | locate | `{"t":…,"track":"T1","peak_x":4.2,"peak_y":7.9,"sharp":6.0}` | Where one pass heard a track loudest; `sharp` is dB above the pass median |
| `ag/coverage` (**new**) | locate | `{"t":…,"x0":-50,"y0":-50,"cell_m":5,"nx":60,"ny":40,"covered":[0,1,1,…],"p":[0,12,255,…],"pct":0.62}` | Coverage and probability grids for the dashboard, about 1 Hz, **retained** so a reloaded dashboard gets it at once. See "Coverage grid" below. Stays on the pod, never goes over LoRa |
| `ag/track` | tracker.py | `{"t":…,"track":"T1","ids":["7f3a9c21","e9910b4c"],"cls":"findmy","x":18.5,"y":9.0,"r95":12.0,"state":"localized","passes":2,"last_s":4,"with_drone":false}` | Best estimate for one beacon. `ids` lists the rotating keys followed through 15-minute changes. `with_drone` marks beacons that move with the drone, such as our own phones |
| `ag/target` (**changed**) | geofence.py | `{"t":…,"pin":"P3","track":"T1","x":18.5,"y":9.0,"lat":44.3387,"lon":-68.2731,"r95":12.0,"c":0.82,"prio":2,"cls":"findmy","state":"localized","last_s":4,"off_trail_m":46,"zone":"trail_corridor","rule":"day_offtrail","status":"new","flags":{"sos":false,"thermal":true,"radar":false,"camera":true},"br":null}` | **The one record** the dashboard, LoRa alerts and ATAK use. One per pin. `state` and `last_s` come from the track (see "How geofence fills a pin"). Optional `sos` (`{"hurt":true,"walk":false,"count":2}`) once an SOS answer is attached |
| `ag/thermal` | thermal.py | `{"t":…,"max_c":33.8,"hot":true,"col":17,"row":9,"conf":0.7}` | Warmest spot in the 32×24 frame. Frames for the panel are image files over HTTP, not MQTT (see "Images over HTTP") |
| `ag/vision` (**new**) | person.py | `{"t":…,"kind":"person","conf":0.82,"box":[1820,940,96,140],"snap":"snaps/1731000000123.jpg","track":"T1"}` | Camera check. `kind` is `person` or `colour` (the Monviso-style colour check). `snap` is also its URL path on port 8080 |
| `ag/radar` | radar.py | `{"t":…,"present":true,"range_m":1.1,"br":14,"hr":72}` | Breathing and heart rate, landed only (tier 3) |
| `ag/plan` (**new**) | planner.py | `{"t":…,"id":"L7","kind":"homing","legs":[{"to_x":20,"to_y":5,"heading_deg":72,"dist_m":35,"alt_m":8}],"status":"proposed"}` | Legs for the pilot. `kind` is `patrol`, `grid` or `homing`. The ranger accepts on the dashboard; the observer reads heading and distance to the pilot |
| `ag/mode` (**changed**) | dashboard.py | `{"t":…,"mode":"investigate"}` | `patrol`, `night`, `investigate` or `search` (the four modes in the build doc) |
| `ag/ctrl` | dashboard.py | `{"t":…,"cmd":"ack","pin":"P3"}` | Operator commands, listed below |
| `ag/sys` (**new**) | health (Utility) | `{"t":…,"cpu_c":61.2,"throttled":"0x0","gps_fix":true,"lora":true,"disk_free_gb":41.0,"batt_pct":null}` | Pod health for the dashboard. Optional `batt_pct` (0–100, or `null`): `null` for now, because nothing on the pod can read the LiPo yet (the Pi only sees the converter's 5 V). A real reading needs a voltage divider into a XIAO analog pin (tier 3) |

### `cls` values (beacon type)

| `cls` | What it is | Reported |
|---|---|---|
| `findmy` | Apple offline-finding beacon: manufacturer data starting `4C 00 12 19`. A dead, off or cut-off iPhone, or an AirTag | Always |
| `findhub` | Google Find Hub accessory frame (service data `0xFEAA`) | Always |
| `samsung_off` | Samsung lost-mode advert (service `0xFD69`) | Always |
| `ref` | Our reference beacon: manufacturer data `FF FF 'A' 'G'` | Always |
| `apple_other` | Other Apple frames from live devices | Only with `REPORT_ALL` |
| `other` | Anything else | Only with `REPORT_ALL` |

### `ag/ctrl` commands

| `cmd` | Extra fields | Who acts on it |
|---|---|---|
| `new_search` | none | bridge.py (new salt), tracker.py (clear) |
| `baseline_start`, `baseline_stop` | none | tracker.py: beacons seen during the baseline show grey |
| `ack`, `investigate`, `clear`, `confirm` | `pin` | geofence.py updates the pin `status`; planner.py starts homing on `investigate` |
| `accept_leg`, `reject_leg` | `id` | planner.py |
| `waypoint` | `n` (taped waypoint number) | position.py, indoors |
| `lora_off`, `lora_on` | none | lora_out.py. Turn LoRa off if the pilot's control link drops |
| `sos_on`, `sos_off` | none | bridge.py forwards to the WIFI board |

### Pin states and priority

- **Track state:**
  - `heard`: somewhere in range.
  - `localized`: 95% within 25 m outdoors (5 m indoors).
  - `pinned`: within 10 m outdoors (2 m indoors).
  - `confirmed`: the ranger confirmed a person. It appears only on `ag/target`; `ag/track` never carries it.
  - Set the outdoor numbers from ME 2's range test. These are placeholders.
- **Pin `status`:** `new` → `acknowledged` → `investigating` → `confirmed` or `cleared`.
- **`rule`** (why it's a pin):
  - `day_offtrail`: farther off-trail than `offtrail_m`, seen on 2 or more passes.
  - `night_outside_camp`: any beacon outside campgrounds after closing.
  - `search`: any `findmy`, `findhub` or `samsung_off` beacon during an active search.
  - `sos`: an SOS answer with no pin under investigation (see "SOS answers").
- **`prio`**, which sets the ATAK colour:
  - 1, red: confirmed, or an SOS that says hurt.
  - 2, orange: pinned and c ≥ 0.8.
  - 3, yellow: localized, or 0.5 ≤ c < 0.8.
  - 4, grey: heard only.

### How geofence fills a pin

- `state` and `last_s` are copied from the latest `ag/track` for that track.
- The one exception: `state` becomes `confirmed` only when the ranger presses Confirm (pin `status` `confirmed`). The tracker never sets it. That keeps the rule that the drone never decides.

### SOS answers

geofence.py listens to `ag/sos`, not lora_out.py, because priority 1 and `flags.sos` live on `ag/target`, and the dashboard and ATAK need them too.

- The SOS page only runs during Investigate, so the answer goes on the pin whose `status` is `investigating`.
- geofence adds `"sos":{"hurt":…,"walk":…,"count":…}`, sets `flags.sos`, and sets `prio` 1 if the person says they're hurt.
- If no pin is being investigated, geofence opens an SOS-only pin at the pod's position (from `ag/pose`), with `track` `"T0"`, `rule` `"sos"` and `status` `new`. Its other fields:
  - `cls` `"wifi"`, because the answer came over the SOS Wi-Fi page;
  - `c` 0, `state` `heard` and `last_s` 0;
  - `r95` is `sos_r95_m` from the config's `[rules]` table: the SOS page's Wi-Fi range, a placeholder until it's measured;
  - `prio` 1 if the person says they're hurt, otherwise 2.

### Coverage grid

- `ag/coverage` carries two grids of `nx × ny` cells, each a flat list read row by row. Row 0 is the south edge, and each row runs west to east.
- Cell `i` is row `i // nx`, column `i % nx`. Its south-west corner is at `x0 + col·cell_m`, `y0 + row·cell_m`.
- `covered` is 0 or 1: whether the pod has passed within `detect_m` of that cell.
- `p` is 0–255: the combined beacon probability, for the heatmap.
- `pct` is the share of cells covered.
- `cell_m` and `detect_m` are in the config's `[locate]` table. They're placeholders until ME 2's range test.
- The 95% circle needs no topic of its own, because `x`, `y` and `r95` are already on `ag/track` and `ag/target`.

## Images over HTTP

dashboard.py serves everything on one port (`[http] port`, 8080), so there are no cross-origin problems. thermal.py and person.py only write files and need no web code.

| URL on `http://<pi>:8080` | File | Written by |
|---|---|---|
| `/live/thermal.png` | `live/thermal.png` | thermal.py, about 4 times a second |
| `/live/camera.jpg` | `live/camera.jpg` | person.py, about once a second. Only one process can open the camera, so person.py also feeds the panel |
| `/snaps/<t>.jpg` | `snaps/<t>.jpg` (the path in `ag/vision` `snap`) | person.py, one per detection |

- Write each live frame to a temporary file and rename it over the old one, so a reader never gets half a frame.
- The folders are `[http] live_dir` and `snaps_dir`, relative to `code/`. Neither is committed.
- Until the dashboard exists, `python -m http.server 8080` run from `code/` serves the same URLs.

## Serial lines from the ESP32 boards

One JSON object per line, `\n` terminated, 921600 baud, 8N1, on the XIAO's hardware UART (D6 = TX, D7 = RX). Raw addresses appear **only** on these wires.

```
OMNI  → Pi  {"type":"ble","addr":"aa:bb:cc:dd:ee:ff","cls":"findmy","rssi":-71}
WIFI  → Pi  {"type":"wifi","addr":"da:a1:19:00:00:01","rand":true,"rssi":-80,"ch":6}
WIFI  → Pi  {"type":"sos","hurt":true,"walk":false,"count":2,"rssi":-55}
Pi → WIFI  {"cmd":"sos_on"}   {"cmd":"sos_off"}
```

The bridge drops lines that aren't valid JSON and counts them in its log.

## LoRa alert: 16 bytes

Sent by `lora_out.py` over Meshtastic as a `PRIVATE_APP` payload:
- every 5 seconds per active pin;
- at once when a pin changes state or an SOS arrives;
- P1 first, with `wantAck` for P1 and P2.

lora_out.py stays a plain encoder of `ag/target`. Three details:
- **`last_s`:** it sends `last_s + (now − t)/1000`, so the 5-second repeats keep counting even when geofence hasn't republished the pin.
- **Battery (byte 14):** it reads `batt_pct` from the latest `ag/sys` and passes it to `alert.encode` as `battery`. `null` goes out as 255, "unknown".
- **Type:** a pin with `rule` `"sos"` goes out as type 2 (SOS). An SOS attached to a normal pin rides in byte 11 and the SOS flag.

`lora_rx.py` on the laptop decodes it and `cot_out.py` turns it into an ATAK marker. `code/afterglow/alert.py` implements and tests this. Use it, don't re-type it.

`struct.pack('<BBhhBBBBBBHBB', …)`

| Byte | Field | Encoding |
|---|---|---|
| 0 | version and type | High nibble version; low nibble type: 1 track, 2 SOS, 3 confirmed person, 4 heartbeat |
| 1 | track | 0–255 (`T7` → 7) |
| 2–3 | x | int16. **v1: decimetres** (indoor demo, ±3.2 km). **v2: metres** (park scale, ±32 km) |
| 4–5 | y | int16, same scale as x |
| 6 | r95 | uint8. v1 decimetres (to 25.5 m); v2 metres (to 255 m) |
| 7 | state and flags | Low 4 bits state (0 heard, 1 localized, 2 pinned, 3 confirmed). Bit 4 SOS, bit 5 thermal, bit 6 radar, bit 7 camera |
| 8 | confidence | 0–255 = c × 255 |
| 9 | priority and class | High nibble prio 1–4; low nibble class: 0 other, 1 findmy, 2 findhub, 3 samsung_off, 4 ref, 5 wifi |
| 10 | breaths per minute | 0 = unknown |
| 11 | SOS answer | Bit 0 hurt, bit 1 can walk, bits 2–7 headcount (0–63) |
| 12–13 | seconds since last heard | uint16 |
| 14 | pod battery | Percent; 255 = unknown |
| 15 | off-trail distance | Metres, 0–254; 255 = unknown |

Changes from the plan doc's layout: version 2 adds a metres scale, because a park-scale pin can be farther than 25.5 m from where it was heard. Bit 7 and byte 15 were the gas-hazard fields; the drone build has no gas sensor, so they now carry the camera flag and the off-trail distance.

**Meshtastic settings, every board:**
- Region `US`.
- Preset `MediumFast`.
- A private primary channel name and key, set at hour 1. Other teams run Meshtastic too. Every other channel disabled.
- Rebroadcast `LOCAL_ONLY`, so our boards don't spend airtime relaying other teams' packets.
- `code/tools/setup_lora.py` writes all of this and checks it. The name and key live in `code/lora_channel.key`, which is git-ignored; share it by direct message only.

## ATAK (Cursor-on-Target)

- `cot_out.py` converts the alert's x and y back to latitude and longitude around the shared origin:
  - `lat = lat0 + y / 111320`
  - `lon = lon0 + x / (111320 · cos lat0)`
- It sends with `pytak` to ATAK's default multicast address, `239.2.3.1:6969`.
- Callsign: `P1 T1` (priority, then track).
- Remarks, for example: `alive 82% · iPhone (offline) · 46 m off trail · ±12 m`.
- Draw the 95% circle if ATAK renders it. Send the pod as a friendly unit.
- Check the marker type and colours in ATAK on Saturday. Start with a spot marker coloured by priority.
