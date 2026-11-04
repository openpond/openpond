"""Regenerate request and response types without importing the SDK or Node."""
from __future__ import annotations

from pathlib import Path
import subprocess
import sys


def generate_types() -> None:
    generator = Path(__file__).with_name("generate_models.py")
    for arguments in ([], ["--inputs"]):
        subprocess.run([sys.executable, str(generator), *arguments], check=True)


if __name__ == "__main__":
    generate_types()
