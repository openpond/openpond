from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from openpond_training.grouped_grpo_coordinator import (
    GroupedGrpoCoordinator,
    GroupedGrpoCoordinatorDependencies,
    GroupedGrpoCoordinatorError,
    GroupedGrpoCoordinatorSettings,
    content_hash,
)

HASH = "a" * 64


class Fixture:
    def __init__(self, root: Path, *, maximum_steps: int = 1) -> None:
        self.root = root
        self.policy_version = 0
        self.batches: list[dict] = []
        self.clock = 0.0
        self.cancel = False
        self.maximum_steps = maximum_steps
        self.optimizer_failure: str | None = None
        self.malformed_adapter = False
        self.policy_mismatch = False
        self.duplicate_request = False
        self.constant_rewards = False
        self.fail_once = False
        self.failed = False

    def monotonic(self) -> float:
        self.clock += 0.001
        return self.clock

    def timestamp(self) -> str:
        milliseconds = int(self.clock * 1_000)
        return f"2026-07-25T12:00:{milliseconds // 1000:02d}.{milliseconds % 1000:03d}Z"

    def rollout(self, assignment: dict) -> dict:
        if self.fail_once and not self.failed:
            self.failed = True
            raise RuntimeError("transient rollout failure")
        index = assignment["groupIndex"]
        reward = 0.5 if self.constant_rewards else float(index % 2)
        episode = f"episode-{assignment['step']}-{index}"
        request_id = (
            "request-duplicate"
            if self.duplicate_request
            else f"request-{assignment['step']}-{index}"
        )
        trajectory = {
            "schemaVersion": "openpond.learningSignal.v1",
            "id": f"trajectory-{episode}",
            "kind": "trajectory",
            "episodeId": episode,
            "policyVersion": assignment["policyVersion"],
            "approved": True,
            "payload": {
                "optimizerSample": {
                    "modelRequestId": request_id,
                    "servedPolicyVersion": assignment["policyVersion"],
                }
            },
        }
        reward_signal = {
            "schemaVersion": "openpond.learningSignal.v1",
            "id": f"reward-{episode}",
            "kind": "reward",
            "episodeId": episode,
            "policyVersion": assignment["policyVersion"],
            "approved": True,
            "payload": {"reward": reward, "eligible": True},
        }
        return {
            "result": {
                "runId": assignment["runId"],
                "taskId": assignment["taskId"],
                "policyVersion": assignment["policyVersion"],
                "status": "succeeded",
                "terminal": index > 0,
                "grade": {"reward": reward},
            },
            "signals": [trajectory, reward_signal],
        }

    def deliver(self, batch: dict) -> None:
        core = {
            key: value
            for key, value in batch.items()
            if key != "contentHash"
        }
        if batch["contentHash"] != content_hash(core):
            raise RuntimeError("batch hash mismatch")
        if batch["sequence"] != len(self.batches):
            raise RuntimeError("batch sequence mismatch")
        self.batches.append(batch)

    def optimize(self, step: int, _timeout: float) -> dict:
        if self.optimizer_failure:
            raise GroupedGrpoCoordinatorError(self.optimizer_failure)
        adapter = self.root / f"adapter-{step}"
        adapter.mkdir(parents=True, exist_ok=True)
        config = adapter / "adapter_config.json"
        weights = adapter / "adapter_model.safetensors"
        config.write_text(
            json.dumps({"r": 8, "target_modules": ["q_proj"]}),
            encoding="utf-8",
        )
        weights.write_bytes(b"canonical-safetensors")
        if self.malformed_adapter:
            weights.unlink()
        batch = self.batches[step - 1]
        core = {
            "schemaVersion": "openpond.primeRlOptimizerStep.v1",
            "step": step,
            "policyVersion": step - 1,
            "manifestHash": HASH,
            "consumedSignalIds": [
                signal["id"] for signal in batch["signals"]
            ],
            "adapter": {
                "path": str(adapter),
                "configSha256": hashlib.sha256(
                    config.read_bytes()
                ).hexdigest(),
                "weightsSha256": hashlib.sha256(
                    b"canonical-safetensors"
                ).hexdigest(),
            },
        }
        return {**core, "contentHash": content_hash(core)}

    def reload(self, step: int, _optimizer: dict) -> int:
        self.policy_version = step
        return step

    def verify(self, expected: int) -> dict:
        served = expected - 1 if self.policy_mismatch else expected
        weights = hashlib.sha256(b"canonical-safetensors").hexdigest()
        core = {
            "schemaVersion": "openpond.policyReloadVerification.v1",
            "servedPolicyVersion": served,
            "adapterWeightsSha256": weights,
            "verified": not self.policy_mismatch,
        }
        return {**core, "contentHash": content_hash(core)}

    def dependencies(self) -> GroupedGrpoCoordinatorDependencies:
        return GroupedGrpoCoordinatorDependencies(
            rollout=self.rollout,
            deliver_signals=self.deliver,
            wait_optimizer=self.optimize,
            reload_adapter=self.reload,
            verify_policy=self.verify,
            cancelled=lambda: self.cancel,
            monotonic=self.monotonic,
            timestamp=self.timestamp,
        )


def settings(
    *,
    maximum_steps: int = 1,
    timeout_seconds: float = 60,
) -> GroupedGrpoCoordinatorSettings:
    return GroupedGrpoCoordinatorSettings(
        run_id="grouped-run",
        manifest_id="grouped-run",
        manifest_hash=HASH,
        task_ids=("task-1", "task-2"),
        group_size=2,
        maximum_steps=maximum_steps,
        initial_policy_version=0,
        seed=17,
        timeout_seconds=timeout_seconds,
    )


class GroupedGrpoCoordinatorTest(unittest.TestCase):
    def test_complete_group_updates_reloads_and_verifies_policy(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = Fixture(root)
            receipt = GroupedGrpoCoordinator(
                settings=settings(),
                dependencies=fixture.dependencies(),
                state_path=root / "state.json",
            ).run()

            self.assertEqual(receipt["optimizerSteps"], 1)
            self.assertEqual(receipt["finalPolicyVersion"], 1)
            self.assertEqual(len(fixture.batches), 1)
            self.assertEqual(len(fixture.batches[0]["signals"]), 4)
            self.assertEqual(
                [span["name"] for span in receipt["timeline"]],
                [
                    "rollout_group",
                    "signal_assembly",
                    "signal_delivery",
                    "optimizer_execution",
                    "adapter_reload",
                    "post_update_verification",
                ],
            )

    def test_reward_zero_policy_completion_is_kept_in_mixed_group(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = Fixture(root)
            GroupedGrpoCoordinator(
                settings=settings(),
                dependencies=fixture.dependencies(),
                state_path=root / "state.json",
            ).run()
            reward_values = [
                signal["payload"]["reward"]
                for signal in fixture.batches[0]["signals"]
                if signal["kind"] == "reward"
            ]
            self.assertEqual(reward_values, [0.0, 1.0])

    def test_constant_reward_group_is_rejected_before_delivery(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = Fixture(root)
            fixture.constant_rewards = True
            with self.assertRaisesRegex(
                GroupedGrpoCoordinatorError,
                "constant_reward_group",
            ):
                GroupedGrpoCoordinator(
                    settings=settings(),
                    dependencies=fixture.dependencies(),
                    state_path=root / "state.json",
                ).run()
            self.assertEqual(fixture.batches, [])

    def test_duplicate_model_request_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = Fixture(root)
            fixture.duplicate_request = True
            with self.assertRaisesRegex(
                GroupedGrpoCoordinatorError,
                "rollout_lineage_invalid",
            ):
                GroupedGrpoCoordinator(
                    settings=settings(),
                    dependencies=fixture.dependencies(),
                    state_path=root / "state.json",
                ).run()

    def test_stale_served_policy_is_rejected_after_reload(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = Fixture(root)
            fixture.policy_mismatch = True
            with self.assertRaisesRegex(
                GroupedGrpoCoordinatorError,
                "policy_verification_invalid",
            ):
                GroupedGrpoCoordinator(
                    settings=settings(),
                    dependencies=fixture.dependencies(),
                    state_path=root / "state.json",
                ).run()

    def test_cancellation_stops_before_rollout(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = Fixture(root)
            fixture.cancel = True
            with self.assertRaisesRegex(
                GroupedGrpoCoordinatorError,
                "cancelled",
            ):
                GroupedGrpoCoordinator(
                    settings=settings(),
                    dependencies=fixture.dependencies(),
                    state_path=root / "state.json",
                ).run()

    def test_timeout_stops_the_coordinator(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = Fixture(root)
            with self.assertRaisesRegex(
                GroupedGrpoCoordinatorError,
                "timeout",
            ):
                GroupedGrpoCoordinator(
                    settings=settings(timeout_seconds=0.0001),
                    dependencies=fixture.dependencies(),
                    state_path=root / "state.json",
                ).run()

    def test_trainer_failure_is_preserved(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = Fixture(root)
            fixture.optimizer_failure = "prime_rl_trainer_step_failed"
            with self.assertRaisesRegex(
                GroupedGrpoCoordinatorError,
                "trainer_step_failed",
            ):
                GroupedGrpoCoordinator(
                    settings=settings(),
                    dependencies=fixture.dependencies(),
                    state_path=root / "state.json",
                ).run()

    def test_malformed_adapter_is_rejected_before_reload(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = Fixture(root)
            fixture.malformed_adapter = True
            with self.assertRaisesRegex(
                GroupedGrpoCoordinatorError,
                "optimizer_receipt_invalid",
            ):
                GroupedGrpoCoordinator(
                    settings=settings(),
                    dependencies=fixture.dependencies(),
                    state_path=root / "state.json",
                ).run()

    def test_retry_resumes_after_optimizer_wait_without_replaying_group(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = Fixture(root, maximum_steps=2)
            fixture.optimizer_failure = "transient_optimizer_failure"
            coordinator = GroupedGrpoCoordinator(
                settings=settings(maximum_steps=2),
                dependencies=fixture.dependencies(),
                state_path=root / "state.json",
            )
            with self.assertRaisesRegex(
                GroupedGrpoCoordinatorError,
                "transient_optimizer_failure",
            ):
                coordinator.run()
            self.assertEqual(len(fixture.batches), 1)
            fixture.optimizer_failure = None
            receipt = coordinator.run()
            self.assertEqual(receipt["optimizerSteps"], 2)
            self.assertEqual(receipt["finalPolicyVersion"], 2)
            self.assertEqual(len(fixture.batches), 2)


if __name__ == "__main__":
    unittest.main()
