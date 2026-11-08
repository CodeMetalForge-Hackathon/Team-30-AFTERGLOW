# Operator TV (`web/tv.html`)

The ops-room screen: big, calm, and only shows what needs a decision. It wraps the panels
around the live map (`web/livemap.js`, unchanged; see `docs/LIVEMAP.md`). Every button is a
ranger's click: nothing auto-confirms a ping or accepts a leg.

## Run it

```
cd code
.venv/bin/python tools/local_stack.py --config park.toml             # no broker needed; pause and speed on the TV
.venv/bin/python tools/local_stack.py --config park.toml --feeds     # plus fake camera and heat pictures
.venv/bin/python -m afterglow.dashboard --config park.toml            # or with Mosquitto + fake_bus.py
```

Open `http://localhost:8080/tv.html` (8090 if you pass `--port 8090`). Click once anywhere so the
browser allows the ping chime. `?force=lora` shows the LoRa-only banner for the demo.

With the fake pod (`local_stack.py`), the top bar has **pause**, **1× / 2× / 4×** and **Reset**
(`POST /api/sim`). A paused sim never shows as a lost link. Reset (click twice) goes back to time
zero: no pings, no case, day sweep, and every open TV reloads.

## The map

`livemap.js`, seen straight from above: flat, no tilt or rotation, satellite imagery by default
(Satellite / Map toggle). To keep it readable, its beacon dots, track circles, heatmap, labels,
key and tools are switched off through its options, and heard-only or cleared pings are left
off the map (they stay in the ping list). On top we draw a pulsing drone marker, the trail
stretch being searched (amber, turning green as it's flown), the case's car park and a short
key that changes with the mode. The map frames the job: the search box in the sweeps, the
stretch in trail pathing, the drone and the ping in an emergency.

## The park scenario (`park.toml`)

Small on purpose, so it reads at a glance and runs in minutes:
- the sweep box is 300 × 600 m beside Gorham Mountain lot and Ocean Path (about 10 minutes at 1×);
- two things to find: a **false signal first**, a dropped AirTag 40 m off Ocean Path about
  130 m from the lot with nobody near it (the check says "No one here"), then the missing iPhone
  45 m off Ocean Path about 350 m from the lot, with the person beside it;
- the sweep lanes start at the north edge, by the car park (`[sim] lanes_from`), and trail
  pathing always starts where the trail passes the car;
- trail pathing searches the first 600 m of the chosen trail from where it passes the car
  (`[search] segment_m`), about 75 seconds at 1×. The big % on the left counts it.

## Modes

The four buttons are the existing `ag/mode` values with new labels, so no contract changed:

| Button | `ag/mode` | Screen |
|---|---|---|
| Day sweep | `patrol` | Lawn-mower progress, what makes a ping, pings or "No pings", last 3 events, "Open a case" |
| Night sweep | `night` | The same, dimmer; pings only outside the campground; thermal status |
| Trail pathing | `search` | The case (who, start point, carrying, description), how much of the stretch is searched (big %), the top 3 trails from the car (click one to search it), the next leg (Accept / Reject) |
| Emergency | `investigate` | "Read to pilot" heading and distance, the SOS answer, camera check, hand-off coordinates, Confirm / Clear |

Always on top: the mode buttons, a SIMULATED / REPLAY badge (never shown for live data), one
health light that only speaks up on a problem, the chime toggle and the big clock (bus time).

Banners appear only when they matter:
- **LoRa only**: no pose for 10 s (the pod's Wi-Fi is down). Pings from `ag/alert` are listed,
  and every button is locked, because commands go over Wi-Fi.
- **SOS answered** (red): a ping carries an SOS answer. "Open emergency view" switches the mode.
- **New ping** (priority colour): the highest-priority ping still `new`, longest waiting first,
  with a waiting timer. Each new ping plays a chime; SOS and priority 1 play an urgent one.

## The four steps

A thin bar under the top bar shows where the search is: **1 Search · 2 Signal · 3 Check · 4 Rescue**.

1. **Search**: a day or night sweep, or trail pathing for a case.
2. **Signal**: a ping appears (banner and chime).
3. **Check**: press **Investigate**. The ping is linked to the open case (or link one yourself
   with "Link to case" on any ping card). The drone flies to it and circles, and the card fills
   in live: drone over the ping, heat (warm or not), camera (person seen or not).
4. The card then suggests one of two buttons. **The ranger still presses it: the drone never decides.**
   - **4a, person found** (warm and seen): "Confirm person · start rescue" confirms the ping and
     opens Emergency, with the **rescue route** for the ground team drawn on the map (white dots):
     from the car park, along the trail that was searched, then off the trail by compass
     direction, with a walking time. Then **"Team on the way · back to scanning"** records that a
     ground team is sent and goes back to the sweep that was running before the case. The drone
     drops by the person every `[sim] checkin_s` (2 min) for `checkin_dwell_s` (30 s); the
     "Rescue under way" card shows when it last checked in. "Person safe · close case" ends it.
   - **4b, no one here** (nothing warm and nobody seen after about 12 s over it): "Not a person ·
     continue search" clears the ping, and the drone goes back to its path.

In the simulation, phones with `person = true` in `[sim] phones` read warm and show a person
when the drone is close (stand-ins for thermal.py and person.py). The park's missing iPhone has
one; the decoy doesn't. The weather and wind in the top bar are simulated too.

## Camera and heat pictures

The pod's live pictures, `live/camera.jpg` (camera.py) and `live/thermal.png` (thermal.py), served
by the dashboard. Each reloads once a second and only swaps in a frame that has finished
loading, so it never flickers. Pictures are scaled to fit, so a 90° `rotate` in config still fits.

- **Emergency:** the "Camera check" card shows both, the camera above the heat picture, with the
  warmest spot's temperature on the heat picture (`ag/thermal`; "picture only" when `max_c` is null).
  A person detector's snapshot (`ag/vision` `snap`, stretch) replaces the camera for a minute.
- **The other modes:** the **Pictures** switch on the map (Auto / On / Off, remembered per browser)
  puts them in the map's bottom-right corner. Auto shows both while the drone checks a ping
  (Investigate), the heat picture alone in a night sweep, and nothing otherwise.
- **Old pictures:** the server sends `Last-Modified` with each picture. Over 5 s old, the picture
  is dimmed with "Feed frozen" (the camera program stopped); if the server can't be reached it
  says "Feed lost". Neither changes anything else on the TV.

With no pod, `tools/local_stack.py --feeds` writes `camera.py --fake` and `thermal.py --fake`
pictures. They aren't tied to the simulation: the heat picture's blob comes and goes on its own
40 s loop, while the temperature shown comes from the fake pod's `ag/thermal`.

## The case

"Open a case" asks for name, age, what they look like, what they carry (sets the beacon to
expect, and flags matching pings) and the car park (or "not found": start from the park
entrance). Saving switches to trail pathing. The case is personal data: it stays on the
laptop in `runs/` (`[search] case_file`) and never goes on the bus or LoRa.

## Trail ranking (`afterglow/trails.py`)

`likelihood = popularity × exp(−distance from the start / near_m)`, normalised to 100 %. The
car parks, popularity per trail and `near_m` live in the profile's `[search]` table. **They are
SAMPLE numbers**: swap in the published trail-use data when we have it. Time of day isn't in
the score yet.

## In the simulation

While the mode is `search` and a case is open, `fake_bus.py` / `local_stack.py` fly the case's
trail (to the nearest point, then back and forth along it) instead of the lanes. That's a
stand-in for planner.py, which doesn't exist yet. The real pod flies what the pilot flies.

## Known gaps

- With no internet the live map never finishes loading (MapLibre's `load` event waits on the
  online tiles), so it draws no trails, pod or pings. This is in `livemap.js`, not the TV page.
- "From the car" on a ping is a straight line, not a walking route.
- The coverage colour on the map is still the live map's blue (it's drawn inside `livemap.js`).
- When a Find My key rotates and the tracker can't match it, the same phone can come back as a
  second ping (the real tracker and geofence do this, not the TV).
