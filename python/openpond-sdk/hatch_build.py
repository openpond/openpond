"""Recreate public Python types for isolated wheel, sdist and editable builds."""
from __future__ import annotations

from pathlib import Path
import subprocess
import sys

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class CustomBuildHook(BuildHookInterface):
    def initialize(self, version: str, build_data: dict) -> None:
        subprocess.run(
            [sys.executable, str(Path(self.root) / "tools" / "generate_types.py")],
            check=True,
        )
