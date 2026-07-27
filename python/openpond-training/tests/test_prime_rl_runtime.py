from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
from openpond_training import prime_rl_runtime as runtime


def test_dependency_install_uses_complete_frozen_closure_without_resolution(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        runtime.shutil,
        "which",
        lambda name: "/usr/local/bin/uvx" if name == "uvx" else None,
    )
    requirements = tmp_path / "requirements.txt"

    assert runtime.prime_rl_dependency_install_command(requirements) == [
        "/usr/local/bin/uvx",
        "--from",
        "uv==0.11.1",
        "uv",
        "pip",
        "install",
        "--system",
        "--break-system-packages",
        "--python",
        sys.executable,
        "--no-progress",
        "--no-deps",
        "--reinstall",
        "--no-config",
        "-r",
        str(requirements),
    ]


def test_export_includes_the_lock_pinned_flash_attention_extra(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        runtime.shutil,
        "which",
        lambda name: "/usr/local/bin/uvx" if name == "uvx" else None,
    )
    requirements = tmp_path / "requirements.txt"

    command = runtime.prime_rl_export_command(requirements)

    assert command == [
        "/usr/local/bin/uvx",
        "--from",
        "uv==0.11.1",
        "uv",
        "export",
        "--frozen",
        "--no-dev",
        "--package",
        "prime-rl",
        "--extra",
        "flash-attn",
        "--no-editable",
        "--output-file",
        str(requirements),
    ]


def test_local_install_is_no_deps_and_reinstalls_exact_checkouts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        runtime.shutil,
        "which",
        lambda name: "/usr/local/bin/uvx" if name == "uvx" else None,
    )

    command = runtime.prime_rl_local_install_command()

    assert command[:4] == [
        "/usr/local/bin/uvx",
        "--from",
        "uv==0.11.1",
        "uv",
    ]
    assert "--no-deps" in command
    assert "--reinstall" in command
    assert "--no-config" in command
    assert command[-5:] == list(runtime.PRIME_RL_LOCAL_PACKAGES)


def test_torch_uninstall_clears_preinstalled_image_packages(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        runtime.shutil,
        "which",
        lambda name: "/usr/local/bin/uvx" if name == "uvx" else None,
    )

    assert runtime.prime_rl_torch_uninstall_command() == [
        "/usr/local/bin/uvx",
        "--from",
        "uv==0.11.1",
        "uv",
        "pip",
        "uninstall",
        "--system",
        "--break-system-packages",
        "--python",
        sys.executable,
        "torch",
        "torchaudio",
        "torchvision",
    ]


def test_dependency_version_gate_rejects_preinstalled_torch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        runtime.importlib.metadata,
        "version",
        lambda package: (
            "2.13.0"
            if package == "torch"
            else runtime.PRIME_RL_FLASH_ATTN_VERSION
        ),
    )

    with pytest.raises(
        RuntimeError,
        match="retained Torch 2.13.0; expected 2.11.0\\+cu128",
    ):
        runtime.validate_prime_rl_dependency_versions()


def test_all_submodule_network_commands_force_github_https(
    tmp_path: Path,
) -> None:
    command = runtime.git_https_command(
        tmp_path / "deps" / "renderers",
        "fetch",
        "--unshallow",
    )

    assert command == [
        "git",
        "-C",
        str(tmp_path / "deps" / "renderers"),
        "-c",
        "url.https://github.com/.insteadOf=git@github.com:",
        "fetch",
        "--unshallow",
    ]


def test_dependency_requirements_remove_local_projects_and_pin_torch_wheels(
    tmp_path: Path,
) -> None:
    source = tmp_path / "full.txt"
    target = tmp_path / "dependencies.txt"
    source.write_text(
        """.
./deps/pydantic-config
dion @ git+https://example.test/dion@abc
./deps/renderers
./deps/verifiers
./packages/prime-rl-configs
flash-linear-attention @ git+https://example.test/fla@def
torch==2.11.0+cu128 \\
    --hash=sha256:d252cf975fb18c94a85336323ad425f473df56dab35a44b00399bd70c7a3b997
torchaudio==2.11.0+cu128 \\
    --hash=sha256:78b86a17f164bdaabdcee93fdfde2587fc43b9ebf15cd61dcf730b4f8615176b
torchvision==0.26.0+cu128 \\
    --hash=sha256:ccf26b4b659cfce6f2208cb8326071d51c70219a34856dfdf468d1e19af52c0d
""",
        encoding="utf-8",
    )

    runtime.write_dependency_requirements(source, target)

    assert target.read_text(encoding="utf-8").splitlines() == [
        "dion @ git+https://example.test/dion@abc",
        "flash-linear-attention @ git+https://example.test/fla@def",
        f"torch @ {runtime.TORCH_WHEEL_URL} \\",
        "    --hash=sha256:d252cf975fb18c94a85336323ad425f473df56dab35a44b00399bd70c7a3b997",
        f"torchaudio @ {runtime.TORCHAUDIO_WHEEL_URL} \\",
        "    --hash=sha256:78b86a17f164bdaabdcee93fdfde2587fc43b9ebf15cd61dcf730b4f8615176b",
        f"torchvision @ {runtime.TORCHVISION_WHEEL_URL} \\",
        "    --hash=sha256:ccf26b4b659cfce6f2208cb8326071d51c70219a34856dfdf468d1e19af52c0d",
    ]


def test_dependency_install_never_exposes_a_broad_pytorch_index(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        runtime.shutil,
        "which",
        lambda name: "/usr/local/bin/uvx" if name == "uvx" else None,
    )

    command = runtime.prime_rl_dependency_install_command(
        tmp_path / "requirements.txt"
    )

    assert "--no-deps" in command
    assert "--reinstall" in command
    assert "--index" not in command
    assert "--index-strategy" not in command
    assert all(
        "download.pytorch.org/whl/cu128" not in argument
        for argument in command
    )


def test_runtime_bootstrap_requires_uvx(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(runtime.shutil, "which", lambda _name: None)

    with pytest.raises(RuntimeError, match="requires the uvx executable"):
        runtime.prime_rl_uv_command()


def test_pins_upstream_and_all_required_submodules() -> None:
    assert runtime.PRIME_RL_COMMIT == (
        "e0d60e4d85ea636873acb2e7083e794740d20226"
    )
    assert runtime.PRIME_RL_SUBMODULES == {
        "deps/pydantic-config": (
            "99f47c6cc043e91c995fae225a495a92efe1126c"
        ),
        "deps/renderers": (
            "201f88516c012bf9f3e6204283f0fcc85c9b40ef"
        ),
        "deps/verifiers": (
            "19fdd9cae10ad26480ac74673267cfc046b8b299"
        ),
    }


def test_runtime_gate_bootstraps_before_import_and_vllm(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    events: list[str] = []

    def bootstrap(run_dir: Path) -> None:
        events.append("bootstrap")
        (run_dir / "prime-rl-source").mkdir()
        (run_dir / "prime-rl-source" / "uv.lock").write_text(
            "lock",
            encoding="utf-8",
        )
        (run_dir / "prime-rl-requirements.txt").write_text(
            "full",
            encoding="utf-8",
        )
        (
            run_dir / "prime-rl-dependency-requirements.txt"
        ).write_text("dependencies", encoding="utf-8")

    def inspect(_run_dir: Path) -> subprocess.CompletedProcess[str]:
        events.append("inspect")
        return subprocess.CompletedProcess(
            [],
            0,
            stdout=json.dumps(
                {
                    "primeRlVersion": runtime.PRIME_RL_VERSION,
                    "torchVersion": "2.11.0+cu128",
                    "transformersVersion": "5.6.2",
                    "vllmVersion": "0.24.0",
                    "trainingBatchType": "TrainingBatch",
                    "trainingSampleType": "TrainingSample",
                    "trainerModule": "prime_rl.trainer.rl.train",
                }
            ),
            stderr="",
        )

    def inspect_vllm(_run_dir: Path) -> str:
        events.append("vllm")
        return "--enable-auto-tool-choice --tool-call-parser"

    monkeypatch.setattr(runtime, "bootstrap_prime_rl", bootstrap)
    monkeypatch.setattr(runtime, "inspect_prime_rl_runtime", inspect)
    monkeypatch.setattr(runtime, "ensure_vllm_runtime", inspect_vllm)
    monkeypatch.setattr(
        runtime,
        "_git_revision",
        lambda directory: (
            runtime.PRIME_RL_SUBMODULES[str(directory.relative_to(
                tmp_path / "prime-rl-source"
            ))]
            if directory != tmp_path / "prime-rl-source"
            else runtime.PRIME_RL_COMMIT
        ),
    )
    monkeypatch.setattr(
        runtime,
        "_uv_version",
        lambda: "uv 0.11.1 (x86_64-unknown-linux-gnu)",
    )

    runtime.ensure_prime_grpo_runtime(tmp_path)

    assert events == ["bootstrap", "inspect", "vllm"]
    receipt = json.loads(
        (tmp_path / runtime.PRIME_RL_RUNTIME_RECEIPT).read_text(
            encoding="utf-8"
        )
    )
    assert receipt["bootstrapPerformed"] is True
    assert receipt["schemaVersion"] == "openpond.primeRlRuntimeReceipt.v6"
    assert receipt["runtimeProbe"]["torchVersion"] == (
        runtime.PRIME_RL_TORCH_VERSION
    )
    assert receipt["primeRl"]["commit"] == runtime.PRIME_RL_COMMIT
