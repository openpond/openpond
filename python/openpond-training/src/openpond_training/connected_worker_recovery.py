from __future__ import annotations

import json
import os
from pathlib import Path

from .connected_worker_files import content_hash as _content_hash


def _manifest_hash(directory: Path) -> str:
    try:
        plan = json.loads((directory / "resolved-plan.json").read_text())
        return str(plan["manifest"]["contentHash"])
    except (OSError, KeyError, TypeError, json.JSONDecodeError):
        return "0" * 64


def _persisted_worker_terminal_state(directory: Path) -> int | None:
    if (directory / "recovery-failed").is_file():
        return 1
    if (directory / "cancel").exists():
        return 130
    receipt_path = directory / "output" / "prime-rl-execution-receipt.json"
    if receipt_path.is_file():
        try:
            receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
            supplied_hash = receipt.get("contentHash")
            content = {
                key: value
                for key, value in receipt.items()
                if key != "contentHash"
            }
            if (
                isinstance(receipt, dict)
                and supplied_hash == _content_hash(content)
                and receipt.get("manifestHash")
                == _manifest_hash(directory)
            ):
                return 0
        except (OSError, TypeError, json.JSONDecodeError):
            return 1
        return 1
    log_path = directory / "worker.log"
    if log_path.is_file():
        for line in log_path.read_text(
            encoding="utf-8", errors="replace"
        ).splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if (
                isinstance(event, dict)
                and event.get("event") == "failure"
            ):
                return 1
    return None


def _mark_recovery_failed(directory: Path, error: ValueError) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    marker = directory / "recovery-failed"
    with marker.open("w", encoding="utf-8") as file:
        file.write(f"{error}\n")
        file.flush()
        os.fsync(file.fileno())


def _journal_contains(
    path: Path, *, sequence: int, content_hash: str
) -> bool:
    if not path.is_file():
        return False
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            batch = json.loads(line)
        except json.JSONDecodeError:
            continue
        if (
            isinstance(batch, dict)
            and batch.get("sequence") == sequence
            and batch.get("contentHash") == content_hash
        ):
            return True
    return False


def _next_journal_sequence(path: Path) -> int:
    if not path.is_file():
        return 0
    sequences: list[int] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            raise ValueError("connected_worker_signal_journal_invalid")
        sequence = value.get("sequence") if isinstance(value, dict) else None
        if (
            not isinstance(sequence, int)
            or isinstance(sequence, bool)
            or sequence != len(sequences)
        ):
            raise ValueError("connected_worker_signal_journal_invalid")
        sequences.append(sequence)
    return len(sequences)


def _prime_rl_progress(directory: Path) -> tuple[int, int]:
    completed = 0
    receipts = directory / "output" / "prime-rl-step-receipts.jsonl"
    if receipts.is_file():
        completed = sum(
            1 for line in receipts.read_text(encoding="utf-8").splitlines()
            if line.strip()
        )
    try:
        plan = json.loads(
            (directory / "resolved-plan.json").read_text(encoding="utf-8")
        )
        maximum = int(plan["recipe"]["optimizer"]["maxSteps"])
    except (
        OSError,
        KeyError,
        TypeError,
        ValueError,
        json.JSONDecodeError,
    ):
        maximum = 0
    return completed, maximum


def _artifact_kind(name: str) -> str:
    if "adapter" in name:
        return "adapter"
    if "checkpoint" in name:
        return "checkpoint"
    if "eval" in name:
        return "evaluation"
    if "metric" in name:
        return "metrics"
    if "event" in name or "trace" in name:
        return "trace"
    return "receipt"
