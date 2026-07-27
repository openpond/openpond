from __future__ import annotations

from pathlib import Path
from typing import Any

from .canonical_json import content_hash
from .engine_adapters import PrimeRlEngineAdapter
from .learning_signals import parse_signals
from .prime_rl_contracts import PrimeRlBatch, PrimeRlExecutionError
from .prime_rl_settings import resolve_prime_rl_settings
from .prime_rl_values import finite_float, mapping


def project_prime_rl_batch(
    *,
    plan: dict[str, Any],
    signal_values: list[dict[str, Any]],
    step: int,
) -> PrimeRlBatch:
    settings = resolve_prime_rl_settings(plan)
    manifest = mapping(plan.get("manifest"), "resolved plan manifest")
    try:
        projection = PrimeRlEngineAdapter().project(
            method="grpo",
            signals=parse_signals(signal_values),
            manifest=manifest,
        )
    except ValueError as error:
        if "requires approved trajectory/reward pairs" in str(error):
            raise PrimeRlExecutionError(
                "prime_rl_training_group_incomplete"
            ) from error
        raise PrimeRlExecutionError(
            "prime_rl_signal_projection_invalid"
        ) from error
    policy_version = step - 1
    records = [
        record
        for record in projection.records
        if record.get("policyVersion") == policy_version
    ]
    records.sort(
        key=lambda record: (
            str(record.get("episodeId")),
            str(record.get("trajectorySignalId")),
        )
    )
    if len(records) < settings.group_size:
        raise PrimeRlExecutionError("prime_rl_training_group_incomplete")
    selected = records[: settings.group_size]
    rewards = [
        finite_float(record.get("reward"), "reward") for record in selected
    ]
    reward_mean = sum(rewards) / len(rewards)
    centered_rewards = [reward - reward_mean for reward in rewards]
    reward_stddev = (
        sum(value * value for value in centered_rewards)
        / len(centered_rewards)
    ) ** 0.5
    if reward_stddev <= 1e-12:
        raise PrimeRlExecutionError("prime_rl_training_group_constant_reward")
    advantages = [
        centered_reward / reward_stddev
        for centered_reward in centered_rewards
    ]
    projected: list[dict[str, Any]] = []
    lineage = []
    model_request_ids: set[str] = set()
    recipe = mapping(plan.get("recipe"), "resolved plan recipe")
    recipe_reward = mapping(recipe.get("reward"), "GRPO reward")
    dataset = mapping(recipe.get("dataset"), "GRPO dataset")
    rollout = mapping(recipe.get("rollout"), "GRPO rollout")
    for record, reward, advantage in zip(
        selected, rewards, advantages, strict=True
    ):
        sample = mapping(
            record.get("optimizerSample"), "optimizer training sample"
        )
        if sample.get("servedPolicyVersion") != policy_version:
            raise PrimeRlExecutionError(
                "prime_rl_training_sample_policy_mismatch"
            )
        model_request_id = str(sample["modelRequestId"])
        if model_request_id in model_request_ids:
            raise PrimeRlExecutionError(
                "prime_rl_training_sample_duplicate"
            )
        model_request_ids.add(model_request_id)
        if (
            sample["promptTokenCount"] > dataset["maxPromptTokens"]
            or sample["completionTokenCount"]
            > rollout["maxOutputTokens"]
            or len(sample["tokenIds"]) > settings.sequence_length
        ):
            raise PrimeRlExecutionError(
                "prime_rl_training_sample_token_budget_exceeded"
            )
        for lineage_key, expected in (
            ("graderHash", recipe_reward.get("graderHash")),
            ("toolContractHash", recipe_reward.get("toolContractHash")),
        ):
            for source in ("trajectoryLineage", "rewardLineage"):
                signal_lineage = mapping(
                    record.get(source), f"GRPO {source}"
                )
                if signal_lineage.get(lineage_key) != expected:
                    raise PrimeRlExecutionError(
                        "prime_rl_signal_recipe_lineage_mismatch"
                    )
        mask = list(sample["mask"])
        projected.append(
            {
                "tokenIds": list(sample["tokenIds"]),
                "mask": mask,
                "logprobs": list(sample["logprobs"]),
                "temperatures": list(sample["temperatures"]),
                "envName": sample["envName"],
                "advantages": [
                    advantage if trainable else 0.0 for trainable in mask
                ],
            }
        )
        lineage.append(
            {
                "episodeId": record["episodeId"],
                "traceHash": record["traceHash"],
                "trajectorySignalId": record["trajectorySignalId"],
                "rewardSignalId": record["rewardSignalId"],
                "modelRequestId": model_request_id,
                "servedPolicyVersion": sample["servedPolicyVersion"],
                "reward": reward,
                "advantage": advantage,
            }
        )
    trajectory_set_hash = content_hash(
        {
            "step": step,
            "policyVersion": policy_version,
            "lineage": lineage,
        }
    )
    return PrimeRlBatch(
        step=step,
        policy_version=policy_version,
        trajectory_set_hash=trajectory_set_hash,
        reward_mean=reward_mean,
        records=projected,
        consumed_signal_ids=frozenset(
            signal_id
            for record in selected
            for signal_id in (
                str(record["trajectorySignalId"]),
                str(record["rewardSignalId"]),
            )
        ),
    )


def write_prime_rl_batch(path: Path, batch: PrimeRlBatch) -> None:
    try:
        import msgspec
        from prime_rl.transport.types import TrainingBatch, TrainingSample
    except ImportError as error:
        raise PrimeRlExecutionError("prime_rl_runtime_unavailable") from error
    samples = [
        TrainingSample(
            token_ids=record["tokenIds"],
            mask=record["mask"],
            logprobs=record["logprobs"],
            temperatures=record["temperatures"],
            env_name=record["envName"],
            advantages=record["advantages"],
        )
        for record in batch.records
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_bytes(
        msgspec.msgpack.encode(
            TrainingBatch(examples=samples, step=batch.step)
        )
    )
    temporary.replace(path)
