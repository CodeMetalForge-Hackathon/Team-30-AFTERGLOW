#!/usr/bin/env python3
"""Put the AFTERGLOW Meshtastic settings on one LoRa board, then check them.

Every board (pod and laptop) gets region US, preset MediumFast and the same
private primary channel, so other teams' Meshtastic traffic can't read or slow
ours. The channel name and key live in code/lora_channel.key, which git ignores.
The key never goes in the repo, a log or the screen.

    python tools/setup_lora.py --new                          # once per team: make the key file
    python tools/setup_lora.py --port /dev/cu.usbmodem1101    # each board (Pi: --port /dev/lora)
    python tools/setup_lora.py --port /dev/lora --check       # read only: PASS/FAIL per setting

Give teammates lora_channel.key over a direct message, never through git.
The boards keep the key themselves, so lora_out.py and lora_rx.py never need it.
"""
import argparse
import base64
import os
import secrets
import subprocess
import sys
import time
import tomllib
from pathlib import Path

KEY_FILE = Path(__file__).resolve().parent.parent / "lora_channel.key"
NAME_MAX = 11  # Meshtastic channel names are at most 11 characters


def new_channel() -> dict:
    return {"name": "ag-" + secrets.token_hex(3), "psk": secrets.token_bytes(32)}


def git_ignored(path: Path) -> bool | None:
    """True or False if git says, None if this isn't a git checkout."""
    try:
        p = subprocess.run(["git", "check-ignore", "-q", str(path)],
                           cwd=path.parent, capture_output=True)
    except FileNotFoundError:
        return None
    return {0: True, 1: False}.get(p.returncode)


def save(path: Path, ch: dict) -> None:
    if path.exists():
        sys.exit(f"{path} already exists. Every board needs the same key, so don't replace it.")
    if git_ignored(path) is False:
        sys.exit(f"{path} is not git-ignored. Fix .gitignore first.")
    text = ("# AFTERGLOW Meshtastic channel. Never commit this file.\n"
            "# Share it with the team over a direct message only.\n"
            f'name = "{ch["name"]}"\n'
            f'psk = "{base64.b64encode(ch["psk"]).decode()}"\n')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)


def load(path: Path) -> dict:
    if not path.exists():
        sys.exit(f"No {path}. Get it from a teammate, or run --new if the team has no key yet.")
    with open(path, "rb") as f:
        raw = tomllib.load(f)
    ch = {"name": raw["name"], "psk": base64.b64decode(raw["psk"])}
    if not 0 < len(ch["name"]) <= NAME_MAX:
        sys.exit(f"Channel name must be 1-{NAME_MAX} characters.")
    if len(ch["psk"]) != 32:
        sys.exit("The key must be 32 bytes (AES-256).")
    return ch


def apply(node, ch: dict) -> None:
    """Write the settings in one transaction. The board reboots after the commit."""
    from meshtastic.protobuf import channel_pb2, config_pb2

    lora = node.localConfig.lora
    lora.region = config_pb2.Config.LoRaConfig.US
    lora.use_preset = True
    lora.modem_preset = config_pb2.Config.LoRaConfig.MEDIUM_FAST
    lora.tx_enabled = True
    # Relay only our own channel, not other teams' packets: less airtime, fewer delays.
    node.localConfig.device.rebroadcast_mode = config_pb2.Config.DeviceConfig.LOCAL_ONLY

    node.beginSettingsTransaction()
    node.writeConfig("lora")
    node.writeConfig("device")
    for i, c in enumerate(node.channels):
        if i == 0:
            c.role = channel_pb2.Channel.PRIMARY
            c.settings.name = ch["name"]
            c.settings.psk = ch["psk"]
        elif c.role != channel_pb2.Channel.DISABLED:
            c.role = channel_pb2.Channel.DISABLED  # no public side channels
            c.settings.Clear()
        else:
            continue
        node.writeChannel(i)
    node.commitSettingsTransaction()


def check(node, ch: dict) -> list[tuple[str, bool, str]]:
    """(setting, ok, what the board has). Never includes the key itself."""
    from meshtastic.protobuf import channel_pb2, config_pb2

    lora_cfg = config_pb2.Config.LoRaConfig
    lora = node.localConfig.lora
    p = node.channels[0]
    others = [i for i, c in enumerate(node.channels[1:], 1)
              if c.role != channel_pb2.Channel.DISABLED]
    mode = node.localConfig.device.rebroadcast_mode
    return [
        ("region", lora.region == lora_cfg.US, lora_cfg.RegionCode.Name(lora.region)),
        ("preset", lora.use_preset and lora.modem_preset == lora_cfg.MEDIUM_FAST,
         lora_cfg.ModemPreset.Name(lora.modem_preset)),
        ("transmit", lora.tx_enabled, "on" if lora.tx_enabled else "off"),
        ("rebroadcast", mode == config_pb2.Config.DeviceConfig.LOCAL_ONLY,
         config_pb2.Config.DeviceConfig.RebroadcastMode.Name(mode)),
        ("channel name", p.role == channel_pb2.Channel.PRIMARY and p.settings.name == ch["name"],
         p.settings.name or "(default)"),
        ("channel key", p.settings.psk == ch["psk"],
         "matches" if p.settings.psk == ch["psk"] else "different"),
        ("other channels", not others, f"enabled: {others}" if others else "none"),
    ]


def connect(port: str | None, wait_s: float):
    """Open the board, retrying while it reboots or re-enumerates on USB."""
    import meshtastic.serial_interface

    deadline = time.monotonic() + wait_s
    while True:
        iface = None
        try:
            iface = meshtastic.serial_interface.SerialInterface(devPath=port, timeout=20)
            iface.localNode.waitForConfig()
            return iface
        except Exception as e:  # port gone mid-reboot, busy, or no config yet
            if iface is not None:
                try:
                    iface.close()
                except Exception:
                    pass
            if time.monotonic() > deadline:
                sys.exit(f"Can't talk to the board on {port or 'any port'}: {e}")
            time.sleep(2)


def report(rows) -> bool:
    for name, ok, detail in rows:
        print(f"{'PASS' if ok else 'FAIL'}  {name:15} {detail}")
    return all(ok for _, ok, _ in rows)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", help="serial port; leave out to auto-detect a single board")
    ap.add_argument("--keyfile", type=Path, default=KEY_FILE)
    ap.add_argument("--new", action="store_true", help="make the team key file (once, ever)")
    ap.add_argument("--check", action="store_true", help="only read and compare, write nothing")
    args = ap.parse_args()

    if args.new:
        save(args.keyfile, new_channel())
        print(f"Wrote {args.keyfile} (git-ignored). Share it over a direct message only.")
        return

    ch = load(args.keyfile)
    iface = connect(args.port, wait_s=10)
    if not args.check:
        print("Writing settings; the board reboots...")
        apply(iface.localNode, ch)
        time.sleep(2)
        try:
            iface.close()
        except Exception:
            pass  # the reboot may have dropped the port already
        time.sleep(8)
        iface = connect(args.port, wait_s=60)
    ok = report(check(iface.localNode, ch))
    iface.close()
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
