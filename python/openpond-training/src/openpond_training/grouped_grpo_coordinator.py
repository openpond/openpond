"""Durable grouped-GRPO rollout, optimizer, and policy-reload coordinator."""

from __future__ import annotations

import hashlib
import json
import math
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .canonical_json import canonical_json, content_hash


class GroupedGrpoCoordinatorError(RuntimeError):
    pass


def utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


@dataclass(frozen=True)
class GroupedGrpoCoordinatorSettings:
    run_id: str
    manifest_id: str
    manifest_hash: str
    task_ids: tuple[str, ...]
    group_size: int
    maximum_steps: int
    initial_policy_version: int
    seed: int
    timeout_seconds: float
    initial_timeline: tuple[dict[str, Any], ...] = ()

    def validate(self) -> None:
        if (
            not self.run_id
            or not self.manifest_id
            or not _sha256(self.manifest_hash)
            or not self.task_ids
            or len(set(self.task_ids)) != len(self.task_ids)
            or self.group_size < 2
            or self.maximum_steps < 1
            or self.initial_policy_version < 0
            or self.timeout_seconds <= 0
        ):
            raise GroupedGrpoCoordinatorError(
                "grouped_grpo_settings_invalid"
            )


@dataclass(frozen=True)
class GroupedGrpoCoordinatorDependencies:
    rollout: Callable[[dict[str, Any]], dict[str, Any]]
    deliver_signals: Callable[[dict[str, Any]], None]
    wait_optimizer: Callable[[int, float], dict[str, Any]]
    reload_adapter: Callable[[int, dict[str, Any]], int]
    verify_policy: Callable[[int], dict[str, Any]]
    cancelled: Callable[[], bool] = lambda: False
    monotonic: Callable[[], float] = time.monotonic
    timestamp: Callable[[], str] = utc_timestamp


class GroupedGrpoCoordinator:
    def __init__(
        self,
        *,
        settings: GroupedGrpoCoordinatorSettings,
        dependencies: GroupedGrpoCoordinatorDependencies,
        state_path: Path,
    ) -> None:
        settings.validate()
        self.settings = settings
        self.dependencies = dependencies
        self.state_path = state_path

    def run(self) -> dict[str, Any]:
        state = self._load_state()
        deadline = (
            self.dependencies.monotonic()
            + self.settings.timeout_seconds
        )
        timeline = list(state.get("timeline", []))
        timeline.extend(self.settings.initial_timeline)
        policy_version = int(
            state.get(
                "policyVersion",
                self.settings.initial_policy_version,
            )
        )
        next_step = int(state.get("nextStep", 1))
        batch_receipts = list(state.get("batchReceipts", []))
        optimizer_receipts = list(state.get("optimizerReceipts", []))
        reload_receipts = list(state.get("reloadReceipts", []))
        for step in range(next_step, self.settings.maximum_steps + 1):
            self._check_active(deadline)
            expected_policy = (
                self.settings.initial_policy_version + step - 1
            )
            if policy_version != expected_policy:
                raise GroupedGrpoCoordinatorError(
                    "grouped_grpo_resume_policy_mismatch"
                )
            group_id = (
                f"group-{step}-"
                f"{content_hash([self.settings.run_id, step])[:16]}"
            )
            task_id = self.settings.task_ids[
                (step - 1) % len(self.settings.task_ids)
            ]
            resuming_optimizer = (
                state.get("phase") == "waiting_optimizer"
                and state.get("step") == step
                and bool(batch_receipts)
                and batch_receipts[-1].get("step") == step
            )
            if not resuming_optimizer:
                rollouts, rollout_span = self._collect_group(
                    step=step,
                    group_id=group_id,
                    task_id=task_id,
                    policy_version=policy_version,
                    deadline=deadline,
                )
                timeline.append(rollout_span)
                batch, assembly_span = self._signal_batch(
                    step=step,
                    group_id=group_id,
                    task_id=task_id,
                    policy_version=policy_version,
                    rollouts=rollouts,
                )
                timeline.append(assembly_span)
                self._check_active(deadline)
                delivery_started = self._span_start()
                self.dependencies.deliver_signals(batch)
                timeline.append(
                    self._span_finish(
                        "signal_delivery",
                        delivery_started,
                        "succeeded",
                    )
                )
                batch_receipts.append(
                    {
                        "step": step,
                        "groupId": group_id,
                        "taskId": task_id,
                        "policyVersion": policy_version,
                        "batchHash": batch["contentHash"],
                        "signalIds": [
                            str(signal["id"])
                            for signal in batch["signals"]
                        ],
                    }
                )
                self._persist_state(
                    step=step,
                    policy_version=policy_version,
                    next_step=step,
                    phase="waiting_optimizer",
                    batch_receipts=batch_receipts,
                    optimizer_receipts=optimizer_receipts,
                    reload_receipts=reload_receipts,
                    timeline=timeline,
                )
            self._check_active(deadline)
            optimizer_started = self._span_start()
            optimizer = self.dependencies.wait_optimizer(
                step,
                max(0.001, deadline - self.dependencies.monotonic()),
            )
            self._validate_optimizer_receipt(
                receipt=optimizer,
                step=step,
                policy_version=policy_version,
                signal_ids=set(batch_receipts[-1]["signalIds"]),
            )
            timeline.append(
                self._span_finish(
                    "optimizer_execution",
                    optimizer_started,
                    "succeeded",
                )
            )
            optimizer_receipts.append(optimizer)
            self._check_active(deadline)
            reload_started = self._span_start()
            next_policy = self.dependencies.reload_adapter(step, optimizer)
            if next_policy != policy_version + 1:
                raise GroupedGrpoCoordinatorError(
                    "grouped_grpo_reload_policy_mismatch"
                )
            timeline.append(
                self._span_finish(
                    "adapter_reload",
                    reload_started,
                    "succeeded",
                )
            )
            verification_started = self._span_start()
            verification = self.dependencies.verify_policy(next_policy)
            self._validate_policy_verification(
                verification,
                next_policy,
                optimizer,
            )
            timeline.append(
                self._span_finish(
                    "post_update_verification",
                    verification_started,
                    "succeeded",
                )
            )
            reload_receipts.append(verification)
            policy_version = next_policy
            self._persist_state(
                step=step,
                policy_version=policy_version,
                next_step=step + 1,
                phase="step_complete",
                batch_receipts=batch_receipts,
                optimizer_receipts=optimizer_receipts,
                reload_receipts=reload_receipts,
                timeline=timeline,
            )
        receipt_core = {
            "schemaVersion": "openpond.groupedGrpoCoordinatorReceipt.v1",
            "runId": self.settings.run_id,
            "manifestId": self.settings.manifest_id,
            "manifestHash": self.settings.manifest_hash,
            "optimizerSteps": self.settings.maximum_steps,
            "finalPolicyVersion": policy_version,
            "batchReceipts": batch_receipts,
            "optimizerReceipts": optimizer_receipts,
            "reloadReceipts": reload_receipts,
            "timeline": timeline,
            "completedAt": self.dependencies.timestamp(),
        }
        receipt = {
            **receipt_core,
            "contentHash": content_hash(receipt_core),
        }
        self._persist_state(
            step=self.settings.maximum_steps,
            policy_version=policy_version,
            next_step=self.settings.maximum_steps + 1,
            phase="complete",
            batch_receipts=batch_receipts,
            optimizer_receipts=optimizer_receipts,
            reload_receipts=reload_receipts,
            timeline=timeline,
            receipt=receipt,
        )
        return receipt

    def _collect_group(
        self,
        *,
        step: int,
        group_id: str,
        task_id: str,
        policy_version: int,
        deadline: float,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        started = self._span_start()
        rollouts: list[dict[str, Any]] = []
        request_ids: set[str] = set()
        for group_index in range(self.settings.group_size):
            self._check_active(deadline)
            assignment_core = {
                "schemaVersion": "openpond.groupedGrpoAssignment.v1",
                "runId": self.settings.run_id,
                "manifestId": self.settings.manifest_id,
                "manifestHash": self.settings.manifest_hash,
                "step": step,
                "rolloutGroupId": group_id,
                "groupIndex": group_index,
                "taskId": task_id,
                "policyVersion": policy_version,
                "seed": (
                    self.settings.seed
                    + step * 10_000
                    + group_index
                ),
                "createdAt": self.dependencies.timestamp(),
            }
            assignment = {
                **assignment_core,
                "assignmentHash": content_hash(assignment_core),
            }
            rollout = self.dependencies.rollout(assignment)
            self._validate_rollout(
                assignment=assignment,
                rollout=rollout,
                request_ids=request_ids,
            )
            rollouts.append(rollout)
        rewards = [
            _finite_number(
                _mapping(rollout["result"], "result")
                .get("grade", {})
                .get("reward"),
                "rollout reward",
            )
            for rollout in rollouts
        ]
        if max(rewards) - min(rewards) <= 1e-12:
            raise GroupedGrpoCoordinatorError(
                "grouped_grpo_constant_reward_group"
            )
        return (
            rollouts,
            self._span_finish(
                "rollout_group",
                started,
                "succeeded",
            ),
        )

    def _validate_rollout(
        self,
        *,
        assignment: dict[str, Any],
        rollout: dict[str, Any],
        request_ids: set[str],
    ) -> None:
        result = _mapping(rollout.get("result"), "rollout result")
        signals = rollout.get("signals")
        if (
            result.get("runId") != assignment["runId"]
            or result.get("taskId") != assignment["taskId"]
            or result.get("policyVersion")
            != assignment["policyVersion"]
            or result.get("status") != "succeeded"
            or not isinstance(result.get("terminal"), bool)
            or not isinstance(signals, list)
            or len(signals) != 2
            or {signal.get("kind") for signal in signals}
            != {"trajectory", "reward"}
        ):
            raise GroupedGrpoCoordinatorError(
                "grouped_grpo_rollout_invalid"
            )
        trajectory = next(
            signal for signal in signals
            if signal.get("kind") == "trajectory"
        )
        reward = next(
            signal for signal in signals
            if signal.get("kind") == "reward"
        )
        sample = _mapping(
            _mapping(trajectory.get("payload"), "trajectory payload")
            .get("optimizerSample"),
            "optimizer sample",
        )
        request_id = sample.get("modelRequestId")
        if (
            trajectory.get("episodeId") != reward.get("episodeId")
            or trajectory.get("policyVersion")
            != assignment["policyVersion"]
            or reward.get("policyVersion")
            != assignment["policyVersion"]
            or sample.get("servedPolicyVersion")
            != assignment["policyVersion"]
            or not isinstance(request_id, str)
            or not request_id
            or request_id in request_ids
            or reward.get("approved") is not True
            or _mapping(reward.get("payload"), "reward payload")
            .get("eligible") is not True
        ):
            raise GroupedGrpoCoordinatorError(
                "grouped_grpo_rollout_lineage_invalid"
            )
        request_ids.add(request_id)

    def _signal_batch(
        self,
        *,
        step: int,
        group_id: str,
        task_id: str,
        policy_version: int,
        rollouts: list[dict[str, Any]],
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        started = self._span_start()
        signals = [
            signal
            for rollout in rollouts
            for signal in rollout["signals"]
        ]
        ids = [str(signal.get("id")) for signal in signals]
        if (
            len(ids) != len(set(ids))
            or any(not signal_id for signal_id in ids)
        ):
            raise GroupedGrpoCoordinatorError(
                "grouped_grpo_duplicate_signal"
            )
        core = {
            "schemaVersion": "openpond.learningSignalBatch.v1",
            "manifestId": self.settings.manifest_id,
            "manifestHash": self.settings.manifest_hash,
            "sequence": step - 1,
            "signals": signals,
        }
        batch = {**core, "contentHash": content_hash(core)}
        return (
            batch,
            self._span_finish(
                "signal_assembly",
                started,
                "succeeded",
            ),
        )

    def _validate_optimizer_receipt(
        self,
        *,
        receipt: dict[str, Any],
        step: int,
        policy_version: int,
        signal_ids: set[str],
    ) -> None:
        supplied_hash = receipt.get("contentHash")
        core = {
            key: value
            for key, value in receipt.items()
            if key != "contentHash"
        }
        adapter = _mapping(receipt.get("adapter"), "optimizer adapter")
        consumed = receipt.get("consumedSignalIds")
        adapter_path = (
            Path(adapter["path"]).resolve()
            if isinstance(adapter.get("path"), str)
            and adapter["path"]
            else None
        )
        config_path = (
            adapter_path / "adapter_config.json"
            if adapter_path is not None
            else None
        )
        weights_path = (
            adapter_path / "adapter_model.safetensors"
            if adapter_path is not None
            else None
        )
        if (
            supplied_hash != content_hash(core)
            or receipt.get("step") != step
            or receipt.get("policyVersion") != policy_version
            or receipt.get("manifestHash")
            != self.settings.manifest_hash
            or not isinstance(consumed, list)
            or {str(value) for value in consumed} != signal_ids
            or not _sha256(adapter.get("configSha256"))
            or not _sha256(adapter.get("weightsSha256"))
            or not isinstance(adapter.get("path"), str)
            or not adapter["path"]
            or config_path is None
            or weights_path is None
            or not config_path.is_file()
            or not weights_path.is_file()
            or hashlib.sha256(config_path.read_bytes()).hexdigest()
            != adapter.get("configSha256")
            or hashlib.sha256(weights_path.read_bytes()).hexdigest()
            != adapter.get("weightsSha256")
        ):
            raise GroupedGrpoCoordinatorError(
                "grouped_grpo_optimizer_receipt_invalid"
            )

    def _validate_policy_verification(
        self,
        receipt: dict[str, Any],
        policy_version: int,
        optimizer: dict[str, Any],
    ) -> None:
        supplied_hash = receipt.get("contentHash")
        core = {
            key: value
            for key, value in receipt.items()
            if key != "contentHash"
        }
        if (
            supplied_hash != content_hash(core)
            or receipt.get("servedPolicyVersion") != policy_version
            or receipt.get("adapterWeightsSha256")
            != optimizer["adapter"]["weightsSha256"]
            or receipt.get("verified") is not True
        ):
            raise GroupedGrpoCoordinatorError(
                "grouped_grpo_policy_verification_invalid"
            )

    def _check_active(self, deadline: float) -> None:
        if self.dependencies.cancelled():
            raise GroupedGrpoCoordinatorError(
                "grouped_grpo_cancelled"
            )
        if self.dependencies.monotonic() >= deadline:
            raise GroupedGrpoCoordinatorError(
                "grouped_grpo_timeout"
            )

    def _span_start(self) -> tuple[float, str]:
        return (
            self.dependencies.monotonic(),
            self.dependencies.timestamp(),
        )

    def _span_finish(
        self,
        name: str,
        started: tuple[float, str],
        outcome: str,
    ) -> dict[str, Any]:
        completed_at = self.dependencies.timestamp()
        return {
            "name": name,
            "startedAt": started[1],
            "completedAt": completed_at,
            "durationMs": max(
                0,
                (self.dependencies.monotonic() - started[0]) * 1_000,
            ),
            "clock": "monotonic",
            "outcome": outcome,
        }

    def _load_state(self) -> dict[str, Any]:
        if not self.state_path.is_file():
            return {}
        value = json.loads(self.state_path.read_text(encoding="utf-8"))
        supplied_hash = value.get("contentHash")
        core = {
            key: item
            for key, item in value.items()
            if key != "contentHash"
        }
        if (
            supplied_hash != content_hash(core)
            or value.get("schemaVersion")
            != "openpond.groupedGrpoCoordinatorState.v1"
            or value.get("runId") != self.settings.run_id
            or value.get("manifestHash")
            != self.settings.manifest_hash
        ):
            raise GroupedGrpoCoordinatorError(
                "grouped_grpo_state_invalid"
            )
        return value

    def _persist_state(
        self,
        *,
        step: int,
        policy_version: int,
        next_step: int,
        phase: str,
        batch_receipts: list[dict[str, Any]],
        optimizer_receipts: list[dict[str, Any]],
        reload_receipts: list[dict[str, Any]],
        timeline: list[dict[str, Any]],
        receipt: dict[str, Any] | None = None,
    ) -> None:
        core = {
            "schemaVersion": "openpond.groupedGrpoCoordinatorState.v1",
            "runId": self.settings.run_id,
            "manifestHash": self.settings.manifest_hash,
            "step": step,
            "policyVersion": policy_version,
            "nextStep": next_step,
            "phase": phase,
            "batchReceipts": batch_receipts,
            "optimizerReceipts": optimizer_receipts,
            "reloadReceipts": reload_receipts,
            "timeline": timeline,
            "receipt": receipt,
            "updatedAt": self.dependencies.timestamp(),
        }
        value = {**core, "contentHash": content_hash(core)}
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.state_path.with_suffix(
            f"{self.state_path.suffix}.tmp"
        )
        temporary.write_text(canonical_json(value), encoding="utf-8")
        temporary.replace(self.state_path)


def _mapping(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise GroupedGrpoCoordinatorError(
            f"grouped_grpo_{label.replace(' ', '_')}_invalid"
        )
    return value


def _finite_number(value: Any, label: str) -> float:
    if (
        not isinstance(value, (int, float))
        or isinstance(value, bool)
        or not math.isfinite(float(value))
    ):
        raise GroupedGrpoCoordinatorError(
            f"grouped_grpo_{label.replace(' ', '_')}_invalid"
        )
    return float(value)


def _sha256(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    )
