"""Pinned PRIME-RL runtime bootstrap for raw Prime grouped-GRPO jobs."""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import shutil
import subprocess
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from .canonical_json import canonical_json, content_hash
from .prime_rollout_smoke_coordinator import (
    TORCH_WHEEL_URL,
    TORCHAUDIO_WHEEL_URL,
    TORCHVISION_WHEEL_URL,
    ensure_vllm_runtime,
)

PRIME_RL_REPOSITORY = "https://github.com/PrimeIntellect-ai/prime-rl.git"
PRIME_RL_COMMIT = "e0d60e4d85ea636873acb2e7083e794740d20226"
PRIME_RL_VERSION = "0.7.0"
PRIME_RL_UV_VERSION = "0.11.1"
PRIME_RL_TORCH_VERSION = "2.11.0+cu128"
PRIME_RL_FLASH_ATTN_VERSION = "2.8.3+cu128torch2.11"
PRIME_RL_RUNTIME_SCHEMA_VERSION = "openpond.primeRlRuntimeReceipt.v6"
PRIME_RL_TORCH_WHEELS = {
    "torch": TORCH_WHEEL_URL,
    "torchaudio": TORCHAUDIO_WHEEL_URL,
    "torchvision": TORCHVISION_WHEEL_URL,
}
PRIME_RL_SUBMODULES = {
    "deps/pydantic-config": "99f47c6cc043e91c995fae225a495a92efe1126c",
    "deps/renderers": "201f88516c012bf9f3e6204283f0fcc85c9b40ef",
    "deps/verifiers": "19fdd9cae10ad26480ac74673267cfc046b8b299",
}
PRIME_RL_LOCAL_PACKAGES = (
    ".",
    "./deps/pydantic-config",
    "./deps/renderers",
    "./deps/verifiers",
    "./packages/prime-rl-configs",
)
PRIME_RL_RUNTIME_RECEIPT = "prime-rl-runtime-receipt.json"
PRIME_RL_BOOTSTRAP_LOG = "prime-rl-bootstrap.log"

_RUNTIME_PROBE = """
import importlib.metadata
import json
from prime_rl.transport.types import TrainingBatch, TrainingSample
import prime_rl.trainer.rl.train
payload = {
    "primeRlVersion": importlib.metadata.version("prime-rl"),
    "torchVersion": importlib.metadata.version("torch"),
    "transformersVersion": importlib.metadata.version("transformers"),
    "vllmVersion": importlib.metadata.version("vllm"),
    "trainingBatchType": TrainingBatch.__name__,
    "trainingSampleType": TrainingSample.__name__,
    "trainerModule": prime_rl.trainer.rl.train.__name__,
}
print(json.dumps(payload, sort_keys=True))
""".strip()


def ensure_prime_grpo_runtime(run_dir: Path) -> str:
    """Install and verify the exact frozen PRIME-RL closure before rollouts."""

    run_dir.mkdir(parents=True, exist_ok=True)
    receipt_path = run_dir / PRIME_RL_RUNTIME_RECEIPT
    existing_receipt = _read_existing_receipt(receipt_path)
    bootstrap_performed = bool(
        existing_receipt
        and existing_receipt.get("bootstrapPerformed") is True
    )
    if existing_receipt is None:
        bootstrap_prime_rl(run_dir)
        bootstrap_performed = True
    probe = inspect_prime_rl_runtime(run_dir)
    if probe.returncode != 0:
        tail = f"{probe.stdout}\n{probe.stderr}"[-4000:]
        raise RuntimeError(
            "The pinned PRIME-RL runtime failed its pre-rollout import gate."
            f"\nRuntime probe tail:\n{tail}"
        )
    try:
        probe_payload = json.loads(probe.stdout.strip().splitlines()[-1])
    except (IndexError, json.JSONDecodeError) as error:
        raise RuntimeError(
            "The pinned PRIME-RL runtime probe did not return its receipt."
        ) from error
    if probe_payload.get("primeRlVersion") != PRIME_RL_VERSION:
        raise RuntimeError(
            "The pinned PRIME-RL runtime reported an unexpected version."
        )
    if probe_payload.get("torchVersion") != PRIME_RL_TORCH_VERSION:
        raise RuntimeError(
            "The pinned PRIME-RL runtime reported an unexpected Torch "
            "version."
        )
    help_text = ensure_vllm_runtime(run_dir)
    source_root = run_dir / "prime-rl-source"
    requirements_path = run_dir / "prime-rl-requirements.txt"
    dependency_requirements_path = (
        run_dir / "prime-rl-dependency-requirements.txt"
    )
    core = {
        "schemaVersion": PRIME_RL_RUNTIME_SCHEMA_VERSION,
        "primeRl": {
            "repository": PRIME_RL_REPOSITORY,
            "commit": PRIME_RL_COMMIT,
            "version": PRIME_RL_VERSION,
            "sourceCommit": _git_revision(source_root),
            "submodules": {
                relative: _git_revision(source_root / relative)
                for relative in PRIME_RL_SUBMODULES
            },
        },
        "uvVersion": _uv_version(),
        "pythonExecutable": sys.executable,
        "pythonVersion": sys.version.split()[0],
        "bootstrapPerformed": bootstrap_performed,
        "lockSha256": _sha256(source_root / "uv.lock"),
        "requirementsSha256": _sha256(requirements_path),
        "dependencyRequirementsSha256": _sha256(
            dependency_requirements_path
        ),
        "dependencyInstall": {
            "completeFrozenClosure": True,
            "dependencyResolution": False,
            "torchWheels": PRIME_RL_TORCH_WHEELS,
        },
        "runtimeProbe": probe_payload,
    }
    receipt_path.write_text(
        canonical_json({**core, "contentHash": content_hash(core)}),
        encoding="utf-8",
    )
    return help_text


def bootstrap_prime_rl(run_dir: Path) -> None:
    source_root = run_dir / "prime-rl-source"
    log_path = run_dir / PRIME_RL_BOOTSTRAP_LOG
    if not source_root.exists():
        _run_logged(
            [
                "git",
                "clone",
                "--filter=blob:none",
                "--no-checkout",
                PRIME_RL_REPOSITORY,
                str(source_root),
            ],
            cwd=run_dir,
            log_path=log_path,
            timeout=5 * 60,
        )
    _run_logged(
        [
            "git",
            "-C",
            str(source_root),
            "checkout",
            "--detach",
            PRIME_RL_COMMIT,
        ],
        cwd=run_dir,
        log_path=log_path,
        timeout=2 * 60,
    )
    _run_logged(
        git_https_command(
            source_root,
            "submodule",
            "update",
            "--init",
            "--depth",
            "1",
            *PRIME_RL_SUBMODULES.keys(),
        ),
        cwd=run_dir,
        log_path=log_path,
        timeout=10 * 60,
    )
    for relative in PRIME_RL_SUBMODULES:
        submodule = source_root / relative
        if _git_is_shallow(submodule):
            _run_logged(
                git_https_command(
                    submodule,
                    "fetch",
                    "--unshallow",
                ),
                cwd=run_dir,
                log_path=log_path,
                timeout=5 * 60,
            )
        _run_logged(
            git_https_command(
                submodule,
                "fetch",
                "--tags",
                "--force",
            ),
            cwd=run_dir,
            log_path=log_path,
            timeout=5 * 60,
        )
    _verify_source_revisions(source_root)
    requirements_path = run_dir / "prime-rl-requirements.txt"
    _run_logged(
        prime_rl_export_command(requirements_path),
        cwd=source_root,
        log_path=log_path,
        timeout=5 * 60,
    )
    dependency_requirements_path = (
        run_dir / "prime-rl-dependency-requirements.txt"
    )
    write_dependency_requirements(
        requirements_path,
        dependency_requirements_path,
    )
    _run_logged(
        prime_rl_torch_uninstall_command(),
        cwd=source_root,
        log_path=log_path,
        timeout=5 * 60,
    )
    _run_logged(
        prime_rl_dependency_install_command(
            dependency_requirements_path
        ),
        cwd=source_root,
        log_path=log_path,
        timeout=20 * 60,
    )
    validate_prime_rl_dependency_versions()
    _run_logged(
        prime_rl_local_install_command(),
        cwd=source_root,
        log_path=log_path,
        timeout=10 * 60,
    )


def inspect_prime_rl_runtime(
    run_dir: Path,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-c", _RUNTIME_PROBE],
        cwd=run_dir,
        check=False,
        capture_output=True,
        text=True,
        timeout=120,
    )


def prime_rl_uv_command() -> list[str]:
    uvx = shutil.which("uvx")
    if not uvx:
        raise RuntimeError(
            "The Prime-RL image contract requires the uvx executable "
            "for its pinned frozen-lock installer."
        )
    return [uvx, "--from", f"uv=={PRIME_RL_UV_VERSION}", "uv"]


def prime_rl_export_command(requirements_path: Path) -> list[str]:
    return [
        *prime_rl_uv_command(),
        "export",
        "--frozen",
        "--no-dev",
        "--package",
        "prime-rl",
        "--extra",
        "flash-attn",
        "--no-editable",
        "--output-file",
        str(requirements_path),
    ]


def git_https_command(directory: Path, *arguments: str) -> list[str]:
    return [
        "git",
        "-C",
        str(directory),
        "-c",
        "url.https://github.com/.insteadOf=git@github.com:",
        *arguments,
    ]


def prime_rl_dependency_install_command(
    requirements_path: Path,
) -> list[str]:
    return [
        *prime_rl_uv_command(),
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
        str(requirements_path),
    ]


def prime_rl_torch_uninstall_command() -> list[str]:
    return [
        *prime_rl_uv_command(),
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


def validate_prime_rl_dependency_versions() -> None:
    torch_version = importlib.metadata.version("torch")
    if torch_version != PRIME_RL_TORCH_VERSION:
        raise RuntimeError(
            "The frozen PRIME-RL dependency install retained Torch "
            f"{torch_version}; expected {PRIME_RL_TORCH_VERSION}."
        )
    flash_attn_version = importlib.metadata.version("flash-attn")
    if flash_attn_version != PRIME_RL_FLASH_ATTN_VERSION:
        raise RuntimeError(
            "The frozen PRIME-RL dependency install reported flash-attn "
            f"{flash_attn_version}; expected "
            f"{PRIME_RL_FLASH_ATTN_VERSION}."
        )


def prime_rl_local_install_command() -> list[str]:
    return [
        *prime_rl_uv_command(),
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
        *PRIME_RL_LOCAL_PACKAGES,
    ]


def write_dependency_requirements(source: Path, target: Path) -> None:
    lines = source.read_text(encoding="utf-8").splitlines()
    dependency_lines: list[str] = []
    for line in lines:
        stripped = line.strip()
        if stripped in PRIME_RL_LOCAL_PACKAGES:
            continue
        package = stripped.partition("==")[0]
        wheel_url = PRIME_RL_TORCH_WHEELS.get(package)
        if wheel_url is not None and stripped.endswith("\\"):
            indentation = line[: len(line) - len(line.lstrip())]
            dependency_lines.append(
                f"{indentation}{package} @ {wheel_url} \\"
            )
            continue
        dependency_lines.append(line)
    target.write_text(
        "\n".join(dependency_lines) + "\n",
        encoding="utf-8",
    )


def _read_existing_receipt(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        receipt = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(receipt, dict):
        return None
    stored_hash = receipt.get("contentHash")
    core = {
        key: value
        for key, value in receipt.items()
        if key != "contentHash"
    }
    if stored_hash != content_hash(core):
        return None
    prime_rl = receipt.get("primeRl")
    if not isinstance(prime_rl, dict):
        return None
    uv_version = receipt.get("uvVersion")
    matches = (
        receipt.get("schemaVersion")
        == PRIME_RL_RUNTIME_SCHEMA_VERSION
        and prime_rl.get("commit") == PRIME_RL_COMMIT
        and prime_rl.get("sourceCommit") == PRIME_RL_COMMIT
        and prime_rl.get("submodules") == PRIME_RL_SUBMODULES
        and receipt.get("dependencyInstall")
        == {
            "completeFrozenClosure": True,
            "dependencyResolution": False,
            "torchWheels": PRIME_RL_TORCH_WHEELS,
        }
        and isinstance(uv_version, str)
        and uv_version.startswith(f"uv {PRIME_RL_UV_VERSION} ")
    )
    if not matches:
        return None
    run_dir = path.parent
    required_paths = (
        run_dir / "prime-rl-source" / "uv.lock",
        run_dir / "prime-rl-requirements.txt",
        run_dir / "prime-rl-dependency-requirements.txt",
    )
    if any(not required_path.is_file() for required_path in required_paths):
        return None
    try:
        _verify_source_revisions(run_dir / "prime-rl-source")
    except RuntimeError:
        return None
    return receipt


def _verify_source_revisions(source_root: Path) -> None:
    if _git_revision(source_root) != PRIME_RL_COMMIT:
        raise RuntimeError("Pinned PRIME-RL source commit verification failed.")
    for relative, expected in PRIME_RL_SUBMODULES.items():
        if _git_revision(source_root / relative) != expected:
            raise RuntimeError(
                f"Pinned PRIME-RL submodule verification failed: {relative}"
            )


def _git_revision(directory: Path) -> str:
    result = subprocess.run(
        ["git", "-C", str(directory), "rev-parse", "HEAD"],
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"Could not inspect pinned source revision at {directory}."
        )
    return result.stdout.strip()


def _git_is_shallow(directory: Path) -> bool:
    result = subprocess.run(
        [
            "git",
            "-C",
            str(directory),
            "rev-parse",
            "--is-shallow-repository",
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )
    return result.returncode == 0 and result.stdout.strip() == "true"


def _uv_version() -> str:
    result = subprocess.run(
        [*prime_rl_uv_command(), "--version"],
        check=True,
        capture_output=True,
        text=True,
        timeout=60,
    )
    return result.stdout.strip()


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _run_logged(
    command: Sequence[str],
    *,
    cwd: Path,
    log_path: Path,
    timeout: float,
) -> None:
    with log_path.open("ab") as log:
        log.write(f"$ {' '.join(command)}\n".encode())
        log.flush()
        result = subprocess.run(
            list(command),
            cwd=cwd,
            check=False,
            stdout=log,
            stderr=subprocess.STDOUT,
            timeout=timeout,
        )
    if result.returncode != 0:
        tail = log_path.read_text(
            encoding="utf-8",
            errors="replace",
        )[-6000:]
        raise RuntimeError(
            "Pinned PRIME-RL runtime bootstrap failed "
            f"with code {result.returncode}.\nBootstrap log tail:\n{tail}"
        )
