from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import signal
import sys
import time
from typing import Any

from .prime_rl_execution import (
    PrimeRlExecutionError,
    content_hash,
    execute_prime_rl_step,
    load_prime_rl_progress,
    materialize_pinned_model,
    project_prime_rl_batch,
    resolve_prime_rl_settings,
)


def run(args: argparse.Namespace) -> int:
    plan = json.loads(Path(args.plan).read_text(encoding="utf-8"))
    if not isinstance(plan, dict):
        raise PrimeRlExecutionError("prime_rl_resolved_plan_invalid")
    settings = resolve_prime_rl_settings(plan)
    output_directory = Path(args.output).resolve()
    output_directory.mkdir(parents=True, exist_ok=True)
    engine_root = output_directory / ".prime-rl"
    engine_root.mkdir(parents=True, exist_ok=True)
    cancellation = [False]

    def cancel(_signum: int, _frame: Any) -> None:
        cancellation[0] = True

    signal.signal(signal.SIGTERM, cancel)
    signal.signal(signal.SIGINT, cancel)
    deadline = time.monotonic() + settings.wall_time_seconds
    step, consumed_signal_ids = load_prime_rl_progress(
        output_directory=output_directory,
        plan=plan,
        settings=settings,
    )
    model_path: Path | None = None
    if step <= settings.maximum_steps:
        model_root = Path(
            os.environ.get(
                "OPENPOND_PRIME_RL_MODEL_CACHE",
                str(output_directory.parent.parent / "model-cache"),
            )
        ).resolve()
        model_path = materialize_pinned_model(
            settings=settings,
            model_root=model_root,
        )
    emit(
        "start",
        {
            "jobId": args.job_id,
            "engine": "prime-rl",
            "upstreamRevision": plan["engine"]["upstreamRevision"],
            "workerImageDigest": plan["engine"]["workerImageDigest"],
            "device": "cuda",
            "resumedAtStep": step,
        },
    )
    while step <= settings.maximum_steps:
        if cancellation[0] or Path(args.cancel_file).exists():
            emit("cancellation", {"step": step})
            return 130
        if time.monotonic() >= deadline:
            raise PrimeRlExecutionError("prime_rl_signal_deadline_exceeded")
        signals = read_signal_journal(
            Path(args.signals),
            manifest_id=str(plan["manifest"]["id"]),
            manifest_hash=str(plan["manifest"]["contentHash"]),
        )
        candidates = [
            value
            for value in signals
            if str(value.get("id")) not in consumed_signal_ids
        ]
        try:
            batch = project_prime_rl_batch(
                plan=plan,
                signal_values=candidates,
                step=step,
            )
        except PrimeRlExecutionError as error:
            if str(error) == "prime_rl_training_group_incomplete":
                time.sleep(0.25)
                continue
            raise
        timeout = max(1, int(deadline - time.monotonic()))
        try:
            receipt = execute_prime_rl_step(
                plan=plan,
                settings=settings,
                batch=batch,
                engine_root=engine_root,
                output_directory=output_directory,
                model_path=(
                    model_path
                    if model_path is not None
                    else _unreachable_model_path()
                ),
                timeout_seconds=timeout,
                cancelled=lambda: cancellation[0]
                or Path(args.cancel_file).exists(),
            )
        except PrimeRlExecutionError as error:
            if str(error) == "prime_rl_cancelled":
                emit("cancellation", {"step": step})
                return 130
            raise
        consumed_signal_ids.update(batch.consumed_signal_ids)
        emit(
            "progress",
            {
                "step": step,
                "maxSteps": settings.maximum_steps,
                "trajectorySetHash": receipt["trajectorySetHash"],
                "rewardMean": receipt["rewardMean"],
            },
        )
        step += 1
    final = {
        "schemaVersion": "openpond.primeRlExecutionReceipt.v1",
        "jobId": args.job_id,
        "manifestHash": plan["manifest"]["contentHash"],
        "optimizerSteps": settings.maximum_steps,
        "workerImageDigest": plan["engine"]["workerImageDigest"],
        "upstreamRevision": plan["engine"]["upstreamRevision"],
    }
    (output_directory / "prime-rl-execution-receipt.json").write_text(
        json.dumps(
            {**final, "contentHash": content_hash(final)},
            sort_keys=True,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    emit("complete", final)
    return 0


def read_signal_journal(
    path: Path, *, manifest_id: str, manifest_hash: str
) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    content = path.read_text(encoding="utf-8")
    lines = content.splitlines()
    if content and not content.endswith("\n"):
        lines = lines[:-1]
    signals: list[dict[str, Any]] = []
    expected_sequence = 0
    for line in lines:
        if not line.strip():
            continue
        batch = json.loads(line)
        if (
            not isinstance(batch, dict)
            or batch.get("manifestId") != manifest_id
            or batch.get("manifestHash") != manifest_hash
        ):
            raise PrimeRlExecutionError("prime_rl_signal_manifest_mismatch")
        supplied_hash = batch.get("contentHash")
        content = {
            key: value
            for key, value in batch.items()
            if key != "contentHash"
        }
        if supplied_hash != content_hash(content):
            raise PrimeRlExecutionError("prime_rl_signal_batch_hash_mismatch")
        sequence = batch.get("sequence")
        if (
            not isinstance(sequence, int)
            or isinstance(sequence, bool)
            or sequence != expected_sequence
        ):
            raise PrimeRlExecutionError("prime_rl_signal_sequence_invalid")
        expected_sequence += 1
        values = batch.get("signals")
        if not isinstance(values, list):
            raise PrimeRlExecutionError("prime_rl_signal_batch_invalid")
        signals.extend(values)
    return signals


def emit(event: str, payload: dict[str, Any]) -> None:
    print(
        json.dumps(
            {"event": event, "payload": payload},
            sort_keys=True,
        ),
        flush=True,
    )


def _unreachable_model_path() -> Path:
    raise PrimeRlExecutionError("prime_rl_model_not_materialized")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="OpenPond pinned PRIME-RL connected execution worker"
    )
    parser.add_argument("--bundle", required=True)
    parser.add_argument("--plan", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--signals", required=True)
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--cancel-file", required=True)
    args = parser.parse_args()
    try:
        raise SystemExit(run(args))
    except Exception as error:
        emit(
            "failure",
            {
                "code": (
                    str(error)
                    if isinstance(error, PrimeRlExecutionError)
                    else "prime_rl_worker_failed"
                )
            },
        )
        raise


if __name__ == "__main__":
    main()
