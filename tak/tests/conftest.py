"""tak/tests run on their own: python -m pytest tak/tests (from the repo root). They find tak/ and code/ here."""
import sys
from pathlib import Path

TAK = Path(__file__).resolve().parent.parent
for p in (TAK, TAK.parent / "code", TAK.parent / "code" / "tools"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))
