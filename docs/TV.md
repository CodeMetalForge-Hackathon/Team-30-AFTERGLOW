# Operator TV (`web/tv.html`)

The ops-room screen: big, calm, and only shows what needs a decision. It wraps the panels
around the live map (`web/livemap.js`, unchanged; see `docs/LIVEMAP.md`). Every button is a
ranger's click: nothing auto-confirms a ping or accepts a leg.

## Run it

```
cd code
.venv/bin/python tools/local_stack.py --config park.toml --speed 10   # no broker needed
.venv/bin/python -m afterglow.dashboard --config park.toml            # or with Mosquitto + fake_bus.py
```

Open `http://localhost:8080/tv.html` (8090 if you pass `--port 8090`). Click once anywhere so the
browser allows the ping chime. `?force=lora` shows the LoRa-only banner for the demo.

## Modes

The four buttons are the existing `ag/mode` values with new labels, so no contract changed:

| Button | `ag/mode` | Screen |
|---|---|---|
| Day sweep | `patrol` | Lawn-mower progress, what makes a ping, pings or "No pings", last 3 events, "Open a case" |
| Night sweep | `night` | The same, dimmer; pings only outside the campground; thermal status |
| Trail pathing | `search` | The case card (who, start point, carrying, description), the most likely trails from the car (click one to fly it), trail progress, the next leg (Accept / Reject) |
| Emergency | `investigate` | "Read to pilot" heading and distance, the SOS answer, camera check, hand-off coordinates, Confirm / Clear |

Always on top: the mode buttons, a SIMULATED / REPLAY badge (never shown for live data), one
health light that only speaks up on a problem, the chime toggle and the big clock (bus time).

Banners appear only when they matter:
- **LoRa only**: no pose for 10 s (the pod's Wi-Fi is down). Pings from `ag/alert` are listed,
  and every button is locked, because commands go over Wi-Fi.
- **SOS answered** (red): a ping carries an SOS answer. "Open emergency view" switches the mode.
- **New ping** (priority colour): the highest-priority ping still `new`, longest waiting first,
  with a waiting timer. Each new ping plays a chime; SOS and priority 1 play an urgent one.

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
- The live map's key still says "pin".
