from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .canonical_json import content_hash
from .engine_adapters import (
    PRIME_RL_BASE_IMAGE_DIGEST,
    PRIME_RL_UPSTREAM_REVISION,
)
from .prime_rl_configuration import (
    render_prime_rl_run_config,
    render_prime_rl_trainer_config,
)
from .prime_rl_contracts import (
    PrimeRlBatch,
    PrimeRlExecutionError,
    PrimeRlSettings,
)

BatchWriter = Callable[[Path, PrimeRlBatch], None]
CancellableCommand = Callable[..., int]


def execute_prime_rl_step(
    *,
    plan: dict[str, Any],
    settings: PrimeRlSettings,
    batch: PrimeRlBatch,
    engine_root: Path,
    output_directory: Path,
    model_path: Path,
    timeout_seconds: int,
    write_batch: BatchWriter,
    run_cancellable: CancellableCommand,
    run_process: Callable[..., subprocess.CompletedProcess[Any]] = subprocess.run,
    cancelled: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    optimizer_started_at = timestamp()
    optimizer_monotonic_started_at = time.monotonic()
    engine_output = engine_root / "output"
    run_root = engine_output / "run_default"
    config_root = engine_root / "config"
    config_root.mkdir(parents=True, exist_ok=True)
    control_root = run_root / "control"
    control_root.mkdir(parents=True, exist_ok=True)
    trainer_config = render_prime_rl_trainer_config(
        settings=settings,
        model_path=model_path,
        output_root=engine_output,
        step=batch.step,
        manifest_hash=str(plan["manifest"]["contentHash"]),
    )
    run_config = render_prime_rl_run_config(
        settings=settings,
        model_path=model_path,
        output_root=engine_output,
        step=batch.step,
    )
    trainer_config_path = config_root / "trainer.toml"
    trainer_config_path.write_text(trainer_config, encoding="utf-8")
    (control_root / "orch.toml").write_text(run_config, encoding="utf-8")
    batch_path = (
        run_root
        / "rollouts"
        / f"step_{batch.step}"
        / "train_rollouts.bin"
    )
    write_batch(batch_path, batch)
    command = [
        sys.executable,
        "-m",
        "torch.distributed.run",
        "--standalone",
        "--nproc-per-node=1",
        "-m",
        "prime_rl.trainer.rl.train",
        "@",
        str(trainer_config_path),
    ]
    if cancelled is None:
        return_code = run_process(
            command,
            check=False,
            cwd=engine_root,
            timeout=timeout_seconds,
        ).returncode
    else:
        return_code = run_cancellable(
            command,
            cwd=engine_root,
            timeout_seconds=timeout_seconds,
            cancelled=cancelled,
        )
    optimizer_completed_at = timestamp()
    optimizer_duration_ms = max(
        0.0,
        (time.monotonic() - optimizer_monotonic_started_at) * 1_000,
    )
    if return_code == 130:
        raise PrimeRlExecutionError("prime_rl_cancelled")
    if return_code != 0:
        raise PrimeRlExecutionError("prime_rl_trainer_step_failed")
    checkpoint_started_at = timestamp()
    checkpoint_monotonic_started_at = time.monotonic()
    weights = engine_output / "weights" / f"step_{batch.step}"
    checkpoint = engine_output / "checkpoints" / f"step_{batch.step}"
    adapter_config = next(weights.rglob("adapter_config.json"), None)
    adapter_model = next(weights.rglob("adapter_model.safetensors"), None)
    if (
        not checkpoint.is_dir()
        or adapter_config is None
        or adapter_model is None
    ):
        raise PrimeRlExecutionError("prime_rl_trainer_artifacts_incomplete")
    checkpoint_target = output_directory / "checkpoints" / f"step-{batch.step}"
    adapter_target = output_directory / "adapter"
    shutil.rmtree(checkpoint_target, ignore_errors=True)
    shutil.rmtree(adapter_target, ignore_errors=True)
    shutil.copytree(checkpoint, checkpoint_target)
    adapter_target.mkdir(parents=True)
    shutil.copy2(adapter_config, adapter_target / "adapter_config.json")
    shutil.copy2(
        adapter_model, adapter_target / "adapter_model.safetensors"
    )
    checkpoint_completed_at = timestamp()
    checkpoint_duration_ms = max(
        0.0,
        (time.monotonic() - checkpoint_monotonic_started_at) * 1_000,
    )
    receipt = {
        "schemaVersion": "openpond.primeRlOptimizerStep.v1",
        "step": batch.step,
        "policyVersion": batch.policy_version,
        "trajectorySetHash": batch.trajectory_set_hash,
        "rewardMean": batch.reward_mean,
        "manifestHash": plan["manifest"]["contentHash"],
        "upstreamRevision": PRIME_RL_UPSTREAM_REVISION,
        "workerImageDigest": plan["engine"]["workerImageDigest"],
        "upstreamImageDigest": PRIME_RL_BASE_IMAGE_DIGEST,
        "trainerConfigHash": hashlib.sha256(
            trainer_config.encode()
        ).hexdigest(),
        "runConfigHash": hashlib.sha256(run_config.encode()).hexdigest(),
        "consumedSignalIds": sorted(batch.consumed_signal_ids),
        "adapterSha256": hashlib.sha256(
            (adapter_target / "adapter_model.safetensors").read_bytes()
        ).hexdigest(),
        "adapter": {
            "path": str(adapter_target.resolve()),
            "configSha256": hashlib.sha256(
                (adapter_target / "adapter_config.json").read_bytes()
            ).hexdigest(),
            "weightsSha256": hashlib.sha256(
                (adapter_target / "adapter_model.safetensors").read_bytes()
            ).hexdigest(),
        },
        "checkpointContentHash": directory_content_hash(checkpoint_target),
        "spans": [
            {
                "name": "optimizer_execution",
                "startedAt": optimizer_started_at,
                "completedAt": optimizer_completed_at,
                "durationMs": optimizer_duration_ms,
                "clock": "monotonic",
                "outcome": "succeeded",
            },
            {
                "name": "checkpoint_writing",
                "startedAt": checkpoint_started_at,
                "completedAt": checkpoint_completed_at,
                "durationMs": checkpoint_duration_ms,
                "clock": "monotonic",
                "outcome": "succeeded",
            },
        ],
    }
    receipt = {**receipt, "contentHash": content_hash(receipt)}
    receipt_path = output_directory / "prime-rl-step-receipts.jsonl"
    with receipt_path.open("a", encoding="utf-8") as file:
        file.write(json.dumps(receipt, sort_keys=True) + "\n")
        file.flush()
        os.fsync(file.fileno())
    return receipt


def timestamp() -> str:
    return (
        time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
        + f".{int(time.time_ns() / 1_000_000) % 1_000:03d}Z"
    )


def load_prime_rl_progress(
    *,
    output_directory: Path,
    plan: dict[str, Any],
    settings: PrimeRlSettings,
) -> tuple[int, set[str]]:
    receipt_path = output_directory / "prime-rl-step-receipts.jsonl"
    if not receipt_path.is_file():
        return 1, set()
    raw = receipt_path.read_text(encoding="utf-8")
    lines = raw.splitlines()
    if raw and not raw.endswith("\n"):
        lines = lines[:-1]
    consumed: set[str] = set()
    expected_step = 1
    for line in lines:
        if not line.strip():
            continue
        try:
            receipt = json.loads(line)
        except json.JSONDecodeError as error:
            raise PrimeRlExecutionError(
                "prime_rl_step_receipt_invalid"
            ) from error
        if not isinstance(receipt, dict):
            raise PrimeRlExecutionError("prime_rl_step_receipt_invalid")
        supplied_hash = receipt.get("contentHash")
        content = {
            key: value
            for key, value in receipt.items()
            if key != "contentHash"
        }
        signal_ids = receipt.get("consumedSignalIds")
        checkpoint = (
            output_directory / "checkpoints" / f"step-{expected_step}"
        )
        if (
            supplied_hash != content_hash(content)
            or receipt.get("schemaVersion")
            != "openpond.primeRlOptimizerStep.v1"
            or receipt.get("step") != expected_step
            or receipt.get("policyVersion") != expected_step - 1
            or receipt.get("manifestHash")
            != plan["manifest"]["contentHash"]
            or receipt.get("upstreamRevision")
            != PRIME_RL_UPSTREAM_REVISION
            or receipt.get("workerImageDigest")
            != plan["engine"]["workerImageDigest"]
            or not isinstance(signal_ids, list)
            or not signal_ids
            or any(
                not isinstance(signal_id, str) or not signal_id
                for signal_id in signal_ids
            )
            or len(set(signal_ids)) != len(signal_ids)
            or any(signal_id in consumed for signal_id in signal_ids)
            or expected_step > settings.maximum_steps
            or not checkpoint.is_dir()
            or receipt.get("checkpointContentHash")
            != directory_content_hash(checkpoint)
        ):
            raise PrimeRlExecutionError(
                "prime_rl_step_receipt_invalid"
            )
        consumed.update(signal_ids)
        expected_step += 1
    return expected_step, consumed


def directory_content_hash(directory: Path) -> str:
    files = []
    for path in sorted(
        (candidate for candidate in directory.rglob("*") if candidate.is_file()),
        key=lambda candidate: candidate.relative_to(directory).as_posix(),
    ):
        if path.is_symlink():
            raise PrimeRlExecutionError(
                "prime_rl_artifact_symlink_unsupported"
            )
        content = path.read_bytes()
        files.append(
            {
                "path": path.relative_to(directory).as_posix(),
                "sha256": hashlib.sha256(content).hexdigest(),
                "sizeBytes": len(content),
            }
        )
    if not files:
        raise PrimeRlExecutionError("prime_rl_checkpoint_empty")
    return content_hash(files)
