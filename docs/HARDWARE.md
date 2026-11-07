# Hardware integration: what's plugged in where, and how software reaches it

Everything here matches the wiring page (`wiring/wiring_and_build.html`) and the build doc's "Drone build plan" tab. If they disagree, the wiring page wins for pins and the build doc wins for decisions.

## The pod in one picture

```
FPV flight LiPo (4S–6S) ──► 5 V 5 A converter ──USB-C──► Raspberry Pi 5 16 GB + Active Cooler + AI HAT+ (Hailo-8)
                                                         │
   OMNI  XIAO ESP32S3 ── UART0  /dev/ttyAMA0  921600 ───┤  BLE beacons (passive)
   WIFI  XIAO ESP32S3 ── UART3  /dev/ttyAMA3  921600 ───┤  Wi-Fi probes, SOS page
   GPS   u-blox M10   ── UART2  /dev/ttyAMA2  38400 ────┤  NMEA position (on the drone's top plate)
   IMU   BNO085       ── I²C-1  0x4A ──┐                │
   Thermal MLX90640   ── I²C-1  0x33 ◄─┘ (STEMMA QT chain)
   Camera Module 3    ── CSI ribbon (through the HAT cutout)
   AI HAT+            ── PCIe ribbon  /dev/hailo0
   LoRa  XIAO+Wio-SX1262 (Meshtastic) ── USB  /dev/lora ──► 915 MHz ──► LoRa board #2 ── USB ── laptop ──► ATAK phone
   Radar MR60BHA2 kit ── USB  /dev/radar  (tier 3)
```

## Device table

| Part | Connects to | Linux sees it as | Settings | Python library | Quick test |
|---|---|---|---|---|---|
| OMNI board (BLE scanner) | Pins 8 TX, 10 RX, 2 5V, 9 GND | `/dev/ttyAMA0` | 921600 8N1 | pyserial | `tools/check_hw.py --only omni` |
| WIFI board (probes + SOS page) | Pins 24 TX, 21 RX, 2 5V, 14 GND | `/dev/ttyAMA3` | 921600 8N1 | pyserial | `--only wifi` |
| GPS module | Pins 7 TX, 29 RX, 4 5V, 30 GND | `/dev/ttyAMA2` | usually 38400 (some 9600 or 115200) | pynmea2 | `--only gps` (finds the baud) |
| IMU BNO085 | STEMMA QT from pins 1, 3, 5, 6 | I²C bus 1, `0x4A` | 400 kHz | adafruit-circuitpython-bno08x | `i2cdetect -y 1` |
| Thermal MLX90640 | STEMMA QT, chained after the IMU | I²C bus 1, `0x33` | 32×24, aim for 4 Hz | adafruit-circuitpython-mlx90640 | `i2cdetect -y 1` |
| Camera Module 3 (imx708) | CSI ribbon, 22-to-15-pin | libcamera camera 0 | 4608×2592 full frame | picamera2 (apt) | `rpicam-hello --list-cameras` |
| AI HAT+ 26 TOPS (Hailo-8) | PCIe ribbon + header | `/dev/hailo0` | PCIe Gen 3 | hailo-all (apt) | `hailortcli fw-control identify` |
| LoRa board (Meshtastic) | USB-A port, up-angled adapter | `/dev/ttyACM*` → `/dev/lora` | Region US, MediumFast, private channel | meshtastic | `tools/setup_lora.py --port /dev/lora --check` |
| Radar MR60BHA2 kit (tier 3) | USB-A port | `/dev/ttyACM*` → `/dev/radar` | kit firmware | pyserial | `--only usb_serial` |
| Power | USB-C from the 5 V 5 A converter | — | `usb_max_current_enable=1`, `PSU_MAX_CURRENT=5000` | — | `vcgencmd get_throttled` must be `0x0` |

## Pin map

Hold the Pi with the USB and Ethernet ports toward you and the header on the right. Pin 1 is the top-left socket, farthest from the ports. Odd pins run down the inner column, even pins down the board edge, two per row: row *n* is pins 2*n*−1 and 2*n*. `wiring/pi_header_labelled.jpg` is our actual board, labelled. `wiring/pins.csv` is the same table as data.

| Pin | Signal | Goes to | | Pin | Signal | Goes to |
|---|---|---|---|---|---|---|
| 1 | 3.3 V | IMU V+ | | 2 | 5 V | OMNI + WIFI 5 V |
| 3 | SDA | IMU SDA | | 4 | 5 V | GPS VCC |
| 5 | SCL | IMU SCL | | 6 | GND | IMU GND |
| 7 | UART2 TX | GPS RX | | 8 | UART0 TX | OMNI RX (D7) |
| 9 | GND | OMNI GND | | 10 | UART0 RX | OMNI TX (D6) |
| 21 | UART3 RX | WIFI TX (D6) | | 14 | GND | WIFI GND |
| 29 | UART2 RX | GPS TX | | 24 | UART3 TX | WIFI RX (D7) |
| 27 | ID_SD | **AI HAT+ only, don't wire** | | 28 | ID_SC | **AI HAT+ only, don't wire** |
| | | | | 30 | GND | GPS GND |

TX always crosses to RX. The sockets on top of the AI HAT+ are **female**, so every lead needs a male pin at the Pi end.

## Pi setup (once)

1. Flash Raspberry Pi OS Bookworm 64-bit. Enable SSH, Wi-Fi to the travel router and a hostname such as `afterglow`.
2. Clone the repo to `/home/pi/afterglow` and run `bash pi/setup_pi.sh`. It:
   - installs Mosquitto, i2c-tools, picamera2 and `hailo-all`;
   - appends `pi/config.txt.append` to `/boot/firmware/config.txt`;
   - turns the serial console off the GPIO UART;
   - adds you to the `dialout`, `i2c` and `video` groups;
   - makes a venv with `--system-site-packages`.
3. `sudo rpi-eeprom-config --edit` and add `PSU_MAX_CURRENT=5000`. Then reboot.
4. Optional: `pi/99-afterglow.rules` (stable `/dev/lora` and `/dev/radar`), `pi/mosquitto-afterglow.conf` (teammates can watch the bus) and `pi/systemd/afterglow@.service` (start modules at boot).
5. `cd code && .venv/bin/python tools/check_hw.py`. Bring-up is done when every connected part passes.

## Gotchas we already know about

- **Board silent on its UART:**
  - The XIAO must print to `Serial0` (D6/D7), not `Serial` (USB). See `firmware/README.md`.
  - TX must cross to RX.
  - The two boards share pin 2 for 5 V but have separate grounds (pins 9 and 14). Both must be connected.
- **Pi 5 serial names:** on the Pi 5, `/dev/ttyAMA10` is the little 3-pin debug connector, not the GPIO header. Our ports are `ttyAMA0`, `ttyAMA2` and `ttyAMA3`, and they only exist after the `config.txt` lines and a reboot.
- **USB serial order:** the LoRa board and the radar both appear as `ttyACM*`, and the order can swap between boots. Use `/dev/serial/by-id/…` or the udev links. Never hard-code `ttyACM0`.
- **Power:**
  - The converter can't announce 5 A over USB-PD, so the Pi assumes 3 A and limits its USB ports to 600 mA. `usb_max_current_enable=1` raises that to 1.6 A; `PSU_MAX_CURRENT=5000` silences the boot warning.
  - The real risk is voltage sag. If `get_throttled` isn't `0x0` with everything running (detector included), shorten and thicken the 5 V lead or check the converter's output with a meter.
- **Heat:** the AI HAT+ adds heat. With the lid closed for 20 minutes, `vcgencmd measure_temp` must stay under 80 °C. If not, run the detector only during Investigate.
- **I²C:** the MLX90640 needs the 400 kHz bus for useful frame rates. If the BNO085 drops off the bus, power-cycle it; it's the fussier of the two. Both should show in `i2cdetect -y 1` as `4a` and `33`.
- **Camera and Hailo from a venv:** both come from apt, so the venv must be created with `--system-site-packages`, or the imports fail.
- **Hailo detection:** start from a model that's already compiled. `rpicam-apps` ships Hailo post-processing stages (see `/usr/share/rpi-camera-assets/hailo_*.json`), and Hailo's `hailo-rpi5-examples` repository has Python detection pipelines. Keep only the `person` class, and tile full frames into 640×640 pieces (build doc, "Person detection plan").
- **Radio coexistence:**
  - Our LoRa is 915 MHz. If the FPV's control link is ELRS 900 MHz, they share a band.
  - The SOS page is 2.4 GHz Wi-Fi, which shares a band with ELRS 2.4 GHz.
  - `lora_out.py` and the WIFI board must obey `ag/ctrl` `lora_off` and `sos_off`, so we can switch them off in flight if the pilot's link quality drops.
- **GPS:**
  - It needs sky. Indoors it reports no fix, which is expected; use the taped waypoints (`ag/ctrl` `waypoint`).
  - First fix outdoors can take a minute or more.
  - If the FPV already has a GPS, Betaflight usually switches it to u-blox's binary format, so don't share it. Use our module.

## Drone facts that matter to software

- **Flight time:** a 5" FPV carrying the 0.4 kg pod flies only about 2–3 minutes; a 7" does better. Patrol legs must be short. The demo is props-off, carried at height.
- **No autopilot:** Betaflight has no waypoint missions. `planner.py` proposes legs; the ranger accepts them on the dashboard; the visual observer reads heading and distance to the pilot.
- **Radar** reads breathing only when landed within about 1.5 m. Drone vibration swamps it in flight.
- **Thermal** is 32×24 pixels. At 30 m a person is smaller than one pixel, so flag heat only from a low hover, under about 8 m.
