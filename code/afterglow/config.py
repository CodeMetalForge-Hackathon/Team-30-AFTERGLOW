"""Load afterglow.toml (shared by the pod and the laptop)."""
import os
import tomllib
from pathlib import Path

DEFAULT = Path(__file__).resolve().parent.parent / "afterglow.toml"


def load(path: str | os.PathLike | None = None) -> dict:
    p = Path(path or os.environ.get("AFTERGLOW_CONFIG", DEFAULT))
    with open(p, "rb") as f:
        cfg = tomllib.load(f)
    # TOML keys are strings; turn the waypoint table into {int: (x, y)}
    cfg["waypoints"] = {int(k): tuple(v) for k, v in cfg.get("waypoints", {}).items()}
    return cfg
