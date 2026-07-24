from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from typing import Any, Iterable


SIGNAL_KINDS = {
    "trajectory",
    "reward",
    "demonstration",
    "preference",
    "correction",
    "critique",
    "targeted_feedback",
    "grader_evidence",
    "infrastructure_failure",
}
VERIFIERS = {"deterministic", "model_judge", "human", "none"}


@dataclass(frozen=True)
class CanonicalSignal:
    id: str
    episode_id: str | None
    policy_version: int | None
    kind: str
    payload: dict[str, Any]
    lineage: dict[str, Any]
    approved: bool
    content_hash: str


def parse_signals(values: Iterable[dict[str, Any]]) -> list[CanonicalSignal]:
    parsed: list[CanonicalSignal] = []
    seen: set[str] = set()
    for value in values:
        if value.get("schemaVersion") != "openpond.learningSignal.v1":
            raise ValueError("unsupported learning signal schema")
        signal_id = _required_string(value, "id")
        if signal_id in seen:
            raise ValueError(f"duplicate learning signal {signal_id}")
        seen.add(signal_id)
        kind = _required_string(value, "kind")
        if kind not in SIGNAL_KINDS:
            raise ValueError(f"unsupported learning signal kind {kind}")
        payload = value.get("payload")
        lineage = value.get("lineage")
        if not isinstance(payload, dict) or not isinstance(lineage, dict):
            raise ValueError(f"learning signal {signal_id} has invalid payload or lineage")
        _validate_lineage(lineage, signal_id)
        approved = value.get("approved")
        if not isinstance(approved, bool):
            raise ValueError(f"learning signal {signal_id} has invalid approval")
        verifier = value.get("verifier")
        if verifier not in VERIFIERS:
            raise ValueError(f"learning signal {signal_id} has invalid verifier")
        task_id = value.get("taskId")
        episode_id = value.get("episodeId")
        policy_version = value.get("policyVersion")
        if task_id is not None and not isinstance(task_id, str):
            raise ValueError(f"learning signal {signal_id} has invalid taskId")
        if episode_id is not None and not isinstance(episode_id, str):
            raise ValueError(f"learning signal {signal_id} has invalid episodeId")
        if policy_version is not None and (
            not isinstance(policy_version, int)
            or isinstance(policy_version, bool)
            or policy_version < 0
        ):
            raise ValueError(
                f"learning signal {signal_id} has invalid policyVersion"
            )
        if not isinstance(value.get("createdAt"), str):
            raise ValueError(f"learning signal {signal_id} has invalid createdAt")
        if not isinstance(value.get("metadata"), dict):
            raise ValueError(f"learning signal {signal_id} has invalid metadata")
        if kind == "infrastructure_failure" and approved:
            raise ValueError("infrastructure failures cannot be approved learning signals")
        if kind == "infrastructure_failure" and verifier != "none":
            raise ValueError(
                "infrastructure failures cannot have a learning verifier"
            )
        if kind == "trajectory":
            _validate_optimizer_sample(payload.get("optimizerSample"), signal_id)
        supplied_hash = _required_string(value, "contentHash")
        content = {
            key: item for key, item in value.items() if key != "contentHash"
        }
        if _content_hash(content) != supplied_hash:
            raise ValueError(
                f"learning signal {signal_id} content hash changed"
            )
        parsed.append(
            CanonicalSignal(
                id=signal_id,
                episode_id=episode_id,
                policy_version=policy_version,
                kind=kind,
                payload=payload,
                lineage=lineage,
                approved=approved,
                content_hash=supplied_hash,
            )
        )
    return parsed


def project_sft_records(signals: Iterable[CanonicalSignal]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for signal in _approved(signals):
        if signal.kind == "demonstration":
            records.append(
                {
                    "prompt": _payload_string(signal, "prompt"),
                    "completion": _payload_string(signal, "response"),
                    "signalId": signal.id,
                    "signalHash": signal.content_hash,
                }
            )
        elif signal.kind == "correction":
            records.append(
                {
                    "prompt": _payload_string(signal, "original"),
                    "completion": _payload_string(signal, "corrected"),
                    "signalId": signal.id,
                    "signalHash": signal.content_hash,
                }
            )
    return records


def project_dpo_records(signals: Iterable[CanonicalSignal]) -> list[dict[str, Any]]:
    return [
        {
            "prompt": _payload_string(signal, "prompt"),
            "chosen": _payload_string(signal, "chosen"),
            "rejected": _payload_string(signal, "rejected"),
            "signalId": signal.id,
            "signalHash": signal.content_hash,
        }
        for signal in _approved(signals)
        if signal.kind == "preference"
    ]


def project_online_rollouts(
    signals: Iterable[CanonicalSignal],
) -> list[dict[str, Any]]:
    approved = list(_approved(signals))
    rewards: dict[str, CanonicalSignal] = {}
    for signal in approved:
        if signal.kind != "reward" or signal.payload.get("eligible") is not True:
            continue
        episode_id = _episode_id(signal)
        if episode_id in rewards:
            raise ValueError(
                f"multiple approved rewards exist for episode {episode_id}"
            )
        rewards[episode_id] = signal
    records: list[dict[str, Any]] = []
    trajectories: set[str] = set()
    for trajectory in approved:
        if trajectory.kind != "trajectory":
            continue
        episode_id = _episode_id(trajectory)
        if episode_id in trajectories:
            raise ValueError(
                f"multiple approved trajectories exist for episode {episode_id}"
            )
        trajectories.add(episode_id)
        reward = rewards.get(episode_id)
        if reward is None:
            continue
        if reward.policy_version != trajectory.policy_version:
            raise ValueError(
                f"trajectory and reward policy versions differ for episode {episode_id}"
            )
        for lineage_key in (
            "environmentHash",
            "graderHash",
            "toolContractHash",
        ):
            if (
                reward.lineage.get(lineage_key)
                != trajectory.lineage.get(lineage_key)
            ):
                raise ValueError(
                    f"trajectory and reward {lineage_key} differ for episode {episode_id}"
                )
        records.append(
            {
                "episodeId": episode_id,
                "traceRef": _payload_string(trajectory, "traceRef"),
                "traceHash": _payload_string(trajectory, "traceHash"),
                "reward": reward.payload.get("reward"),
                "rewardComponents": reward.payload.get("components", {}),
                "trajectorySignalId": trajectory.id,
                "rewardSignalId": reward.id,
                "policyVersion": trajectory.policy_version,
                "optimizerSample": trajectory.payload.get("optimizerSample"),
                "trajectoryLineage": trajectory.lineage,
                "rewardLineage": reward.lineage,
            }
        )
    return records


def _approved(signals: Iterable[CanonicalSignal]) -> Iterable[CanonicalSignal]:
    return (signal for signal in signals if signal.approved)


def _episode_id(signal: CanonicalSignal) -> str:
    episode_id = signal.episode_id or signal.payload.get("episodeId")
    if not isinstance(episode_id, str) or not episode_id:
        episode_id = signal.id
    return episode_id


def _payload_string(signal: CanonicalSignal, key: str) -> str:
    value = signal.payload.get(key)
    if not isinstance(value, str):
        raise ValueError(f"{signal.kind} signal {signal.id} requires payload.{key}")
    return value


def _required_string(value: dict[str, Any], key: str) -> str:
    item = value.get(key)
    if not isinstance(item, str) or not item:
        raise ValueError(f"learning signal requires {key}")
    return item


def _validate_lineage(lineage: dict[str, Any], signal_id: str) -> None:
    _release_ref(lineage.get("datasetRelease"), "datasetRelease", signal_id)
    _release_ref(lineage.get("harnessRelease"), "harnessRelease", signal_id)
    for key in ("evidenceSetRelease", "profileRelease"):
        value = lineage.get(key)
        if value is not None:
            _release_ref(value, key, signal_id)
    model = lineage.get("model")
    if not isinstance(model, dict):
        raise ValueError(f"learning signal {signal_id} has invalid lineage.model")
    _lineage_string(model, "source", signal_id)
    _lineage_string(model, "revision", signal_id)
    artifact_hash = model.get("artifactHash")
    if artifact_hash is not None:
        _sha256(artifact_hash, "model.artifactHash", signal_id)
    for key in ("environmentHash", "graderHash", "toolContractHash"):
        _sha256(lineage.get(key), key, signal_id)
    verification_hash = lineage.get("verificationReceiptHash")
    if verification_hash is not None:
        _sha256(
            verification_hash,
            "verificationReceiptHash",
            signal_id,
        )


def _release_ref(value: Any, key: str, signal_id: str) -> None:
    if not isinstance(value, dict):
        raise ValueError(
            f"learning signal {signal_id} has invalid lineage.{key}"
        )
    _lineage_string(value, "id", signal_id, prefix=f"{key}.")
    _sha256(value.get("contentHash"), f"{key}.contentHash", signal_id)


def _lineage_string(
    value: dict[str, Any],
    key: str,
    signal_id: str,
    *,
    prefix: str = "model.",
) -> str:
    item = value.get(key)
    if not isinstance(item, str) or not item:
        raise ValueError(
            f"learning signal {signal_id} has invalid lineage.{prefix}{key}"
        )
    return item


def _sha256(value: Any, key: str, signal_id: str) -> None:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise ValueError(
            f"learning signal {signal_id} has invalid lineage.{key}"
        )


def _validate_optimizer_sample(value: Any, signal_id: str) -> None:
    if value is None:
        return
    if not isinstance(value, dict):
        raise ValueError(
            f"learning signal {signal_id} has invalid optimizerSample"
        )
    if value.get("schemaVersion") != "openpond.optimizerTrainingSample.v1":
        raise ValueError(
            f"learning signal {signal_id} has unsupported optimizerSample"
        )
    arrays = {
        "tokenIds": value.get("tokenIds"),
        "mask": value.get("mask"),
        "logprobs": value.get("logprobs"),
        "temperatures": value.get("temperatures"),
    }
    if not all(isinstance(items, list) for items in arrays.values()):
        raise ValueError(
            f"learning signal {signal_id} optimizerSample arrays are missing"
        )
    lengths = {len(items) for items in arrays.values()}
    length = len(arrays["tokenIds"])
    if len(lengths) != 1 or not 2 <= length <= 32_768:
        raise ValueError(
            f"learning signal {signal_id} optimizerSample arrays are not aligned"
        )
    if not all(
        isinstance(item, int) and not isinstance(item, bool) and item >= 0
        for item in arrays["tokenIds"]
    ):
        raise ValueError(
            f"learning signal {signal_id} optimizerSample tokenIds are invalid"
        )
    if not all(isinstance(item, bool) for item in arrays["mask"]):
        raise ValueError(
            f"learning signal {signal_id} optimizerSample mask is invalid"
        )
    if not all(
        isinstance(item, (int, float))
        and not isinstance(item, bool)
        and float("-inf") < float(item) < float("inf")
        for key in ("logprobs", "temperatures")
        for item in arrays[key]
    ) or not all(float(item) > 0 for item in arrays["temperatures"]):
        raise ValueError(
            f"learning signal {signal_id} optimizerSample numbers are invalid"
        )
    prompt_count = value.get("promptTokenCount")
    completion_count = value.get("completionTokenCount")
    if (
        not isinstance(prompt_count, int)
        or isinstance(prompt_count, bool)
        or prompt_count <= 0
        or not isinstance(completion_count, int)
        or isinstance(completion_count, bool)
        or completion_count <= 0
        or prompt_count + completion_count != length
        or any(arrays["mask"][:prompt_count])
        or not all(arrays["mask"][prompt_count:])
    ):
        raise ValueError(
            f"learning signal {signal_id} optimizerSample token partition is invalid"
        )
    if not isinstance(value.get("envName"), str) or not value["envName"]:
        raise ValueError(
            f"learning signal {signal_id} optimizerSample envName is invalid"
        )
    if (
        not isinstance(value.get("modelRequestId"), str)
        or not value["modelRequestId"]
    ):
        raise ValueError(
            f"learning signal {signal_id} optimizerSample modelRequestId is invalid"
        )
    served = value.get("servedPolicyVersion")
    if (
        not isinstance(served, int)
        or isinstance(served, bool)
        or served < 0
    ):
        raise ValueError(
            f"learning signal {signal_id} optimizerSample policy is invalid"
        )


def _content_hash(value: Any) -> str:
    canonical = json.dumps(
        value, sort_keys=True, ensure_ascii=False, indent=2
    ) + "\n"
    return hashlib.sha256(canonical.encode()).hexdigest()
