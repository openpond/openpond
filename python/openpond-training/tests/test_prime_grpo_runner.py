from __future__ import annotations

import json
from pathlib import Path

import pytest
from openpond_training.prime_grpo_runner import (
    PrimeGrpoRunnerError,
    claim_runner,
    load_task_ids,
    read_step_receipt,
    release_runner,
    restore_served_policy,
)


def test_load_task_ids_accepts_one_immutable_order(tmp_path: Path) -> None:
    path = tmp_path / "launch.json"
    path.write_text(
        json.dumps({"taskIds": ["task-b", "task-a"]}),
        encoding="utf-8",
    )

    assert load_task_ids(path) == ["task-b", "task-a"]


@pytest.mark.parametrize(
    "task_ids",
    [[], ["task-a", "task-a"], ["task-a", 2]],
)
def test_load_task_ids_fails_closed(
    tmp_path: Path,
    task_ids: list[object],
) -> None:
    path = tmp_path / "launch.json"
    path.write_text(
        json.dumps({"taskIds": task_ids}),
        encoding="utf-8",
    )

    with pytest.raises(
        PrimeGrpoRunnerError,
        match="prime_grpo_task_ids_invalid",
    ):
        load_task_ids(path)


def test_step_receipt_ignores_unflushed_tail(tmp_path: Path) -> None:
    path = tmp_path / "receipts.jsonl"
    expected = {"step": 1, "contentHash": "a" * 64}
    path.write_text(
        json.dumps(expected) + "\n" + '{"step": 2',
        encoding="utf-8",
    )

    assert read_step_receipt(path, 1) == expected
    assert read_step_receipt(path, 2) is None


def test_step_receipt_rejects_duplicate_step(tmp_path: Path) -> None:
    path = tmp_path / "receipts.jsonl"
    path.write_text(
        "\n".join(
            [
                json.dumps({"step": 1}),
                json.dumps({"step": 1}),
                "",
            ]
        ),
        encoding="utf-8",
    )

    with pytest.raises(
        PrimeGrpoRunnerError,
        match="prime_grpo_optimizer_receipt_duplicate",
    ):
        read_step_receipt(path, 1)


def test_restore_served_policy_reloads_latest_verified_adapter(
    tmp_path: Path,
) -> None:
    state_path = tmp_path / "grouped-grpo-state.json"
    state_path.write_text(
        json.dumps(
            {
                "policyVersion": 2,
                "optimizerReceipts": [
                    {
                        "step": 1,
                        "policyVersion": 0,
                        "adapter": {"path": "step-1"},
                    },
                    {
                        "step": 2,
                        "policyVersion": 1,
                        "adapter": {"path": "step-2"},
                    },
                ],
            }
        ),
        encoding="utf-8",
    )

    class Runtime:
        def __init__(self) -> None:
            self.reloaded: list[tuple[int, object]] = []
            self.verified: list[int] = []

        def reload_adapter(
            self,
            policy_version: int,
            receipt: object,
        ) -> int:
            self.reloaded.append((policy_version, receipt))
            return policy_version

        def verify_policy(self, policy_version: int) -> object:
            self.verified.append(policy_version)
            return {"policyVersion": policy_version}

    runtime = Runtime()
    assert restore_served_policy(state_path, runtime) == 2  # type: ignore[arg-type]
    assert runtime.reloaded == [
        (
            2,
            {
                "step": 2,
                "policyVersion": 1,
                "adapter": {"path": "step-2"},
            },
        )
    ]
    assert runtime.verified == [2]


def test_runner_pid_lock_rejects_a_live_owner(
    tmp_path: Path,
) -> None:
    pid_path = claim_runner(tmp_path)
    try:
        with pytest.raises(
            PrimeGrpoRunnerError,
            match="prime_grpo_runner_already_active",
        ):
            claim_runner(tmp_path)
    finally:
        release_runner(pid_path)
    assert not pid_path.exists()
