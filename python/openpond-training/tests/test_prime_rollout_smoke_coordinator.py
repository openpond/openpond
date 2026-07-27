from __future__ import annotations

import sys

import pytest
from openpond_training import prime_rollout_smoke_coordinator as coordinator


def test_vllm_bootstrap_uses_uv_system_install(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(coordinator.shutil, "which", lambda name: "/usr/local/bin/uv")

    assert coordinator.vllm_bootstrap_command() == [
        "/usr/local/bin/uv",
        "pip",
        "install",
        "--system",
        "--break-system-packages",
        "--python",
        sys.executable,
        "--no-progress",
        "--upgrade",
        f"vllm @ {coordinator.VLLM_WHEEL_URL}",
        f"torch @ {coordinator.TORCH_WHEEL_URL}",
        f"torchvision @ {coordinator.TORCHVISION_WHEEL_URL}",
        f"torchaudio @ {coordinator.TORCHAUDIO_WHEEL_URL}",
        "transformers==5.6.2",
    ]


def test_vllm_bootstrap_requires_the_prime_image_uv_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(coordinator.shutil, "which", lambda name: None)

    with pytest.raises(RuntimeError, match="requires the uv executable"):
        coordinator.vllm_bootstrap_command()
