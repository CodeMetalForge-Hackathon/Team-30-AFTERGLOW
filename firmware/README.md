# ESP32 firmware: what the Pi expects

The plan doc has the scanner, wifi_listener and sos_page sketches. This page covers only what the firmware must do for the Pi side to work. Owner: Utility.

## Both XIAO ESP32S3 boards (OMNI and WIFI)

- **Print to the hardware UART, not USB.** The Pi listens on D6 (TX, GPIO43) and D7 (RX, GPIO44).
  - In Arduino-ESP32 3.x, with *USB CDC On Boot: Enabled*, `Serial` is the USB port and `Serial0` is the UART on D6/D7.
  - Use `Serial0.begin(921600)` and `Serial0.printf(...)`. Mirroring to `Serial` while debugging on a laptop is fine.
  - This is the most likely reason `check_hw.py` reports a board as "silent".
- **Line format:** 921600 baud, 8N1. One JSON object per line, `\n` terminated. Exact formats are in `docs/CONTRACTS.md`, "Serial lines from the ESP32 boards".
- **Power:** 5 V and GND come from the Pi's header (pins 2 and 9 for OMNI; 2 and 14 for WIFI). Don't plug USB into a board while it's wired to the Pi unless you're sure your USB cable doesn't back-feed 5 V. When in doubt, unplug the Pi's 5 V lead first.
- **Antenna:** each board needs the stick-on antenna from its own box, on the U.FL socket. Without it, range drops to a few metres.

## OMNI: scanner

- **Passive scan only:** `setActiveScan(false)`, interval = window, so it listens all the time.
- **Always report** `findmy`, `findhub`, `samsung_off` and `ref`. Report everything else only when `REPORT_ALL` is true, so a crowded venue can't flood the serial line.
- **Classify:**

| `cls` | Match |
|---|---|
| `findmy` | Manufacturer data `4C 00 12 …` (Apple offline finding; the plan's gate test uses `4C 00 12 19`) |
| `apple_other` | Other `4C 00` manufacturer data |
| `findhub` | Service data UUID `0xFEAA` |
| `samsung_off` | Service UUID `0xFD69` |
| `ref` | Manufacturer data `FF FF 'A' 'G'` (our reference beacon) |
| `other` | Anything else |

- **Fallback:** if the built-in BLE library drops packets in a crowded room, switch to NimBLE-Arduino.

## WIFI: wifi_listener (tier 1), plus sos_page (tier 2)

- **wifi_listener:** promiscuous mode, management frames, probe requests (`0x40`). Hop channels 1, 6 and 11 every 250 ms. Print `{"type":"wifi",…}` lines.
- **sos_page:** an open AP named `SOS-RESCUE` with a captive page. Print `{"type":"sos",…}` when someone answers.
  - Accept `{"cmd":"sos_on"}` and `{"cmd":"sos_off"}` lines from the Pi.
  - The pod switches the page off in flight if it hurts the pilot's link.
- **Known clash:** while the SOS access point is up, the radio stays on the AP's channel, so the probe listener only hears that one channel. That's fine: the SOS page is for Investigate, when we're hovering over a pin.

## LoRa board (XIAO ESP32S3 + Wio-SX1262)

- Runs stock Meshtastic firmware: no code of ours. The Pi talks to it over USB with the `meshtastic` Python library.
- Settings for every board:
  - Region `US`.
  - Preset `MediumFast`.
  - The team's private channel name and key.
- Check with `meshtastic --port /dev/lora --info`.
