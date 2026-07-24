from __future__ import annotations

from dataclasses import dataclass
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import signal
import subprocess
import time
from typing import Any, Callable

from .engine_adapters import (
    PRIME_RL_BASE_IMAGE_DIGEST,
    PRIME_RL_UPSTREAM_REVISION,
    PrimeRlEngineAdapter,
)
from .learning_signals import parse_signals


class PrimeRlExecutionError(RuntimeError):
    pass


@dataclass(frozen=True)
class PrimeRlSettings:
    model_id: str
    model_revision: str
    tokenizer_revision: str
    sequence_length: int
    group_size: int
    maximum_steps: int
    checkpoint_every_steps: int
    learning_rate: float
    lora_rank: int
    lora_alpha: float
    lora_dropout: float
    wall_time_seconds: int


@dataclass(frozen=True)
class PrimeRlBatch:
    step: int
    policy_version: int
    trajectory_set_hash: str
    reward_mean: float
    records: list[dict[str, Any]]
    consumed_signal_ids: frozenset[str]


def resolve_prime_rl_settings(plan: dict[str, Any]) -> PrimeRlSettings:
    _validate_hashed_object(plan, "prime_rl_resolved_plan_hash_mismatch")
    manifest = _mapping(plan.get("manifest"), "resolved plan manifest")
    _validate_hashed_object(
        manifest, "prime_rl_manifest_hash_mismatch"
    )
    engine = _mapping(plan.get("engine"), "resolved plan engine")
    manifest_engine = _mapping(
        manifest.get("engine"), "Harness Run Manifest engine"
    )
    if engine != manifest_engine:
        raise PrimeRlExecutionError("prime_rl_engine_lineage_mismatch")
    recipe = _mapping(plan.get("recipe"), "resolved plan recipe")
    if engine.get("adapterId") != "connected-prime-rl":
        raise PrimeRlExecutionError("prime_rl_engine_adapter_mismatch")
    if engine.get("upstreamRevision") != PRIME_RL_UPSTREAM_REVISION:
        raise PrimeRlExecutionError("prime_rl_upstream_revision_mismatch")
    if not _worker_digest(engine.get("workerImageDigest")):
        raise PrimeRlExecutionError("prime_rl_worker_image_mismatch")
    if recipe.get("method") != "grpo":
        raise PrimeRlExecutionError("prime_rl_recipe_method_unsupported")
    manifest_recipe = _mapping(
        manifest.get("recipe"), "Harness Run Manifest recipe"
    )
    if manifest_recipe.get("method") != "grpo":
        raise PrimeRlExecutionError("prime_rl_manifest_method_mismatch")
    if manifest_recipe.get("configHash") != content_hash(recipe):
        raise PrimeRlExecutionError("prime_rl_recipe_hash_mismatch")

    base_model = _mapping(recipe.get("baseModel"), "GRPO base model")
    optimizer = _mapping(recipe.get("optimizer"), "GRPO optimizer")
    rollout = _mapping(recipe.get("rollout"), "GRPO rollout")
    dataset = _mapping(recipe.get("dataset"), "GRPO dataset")
    lora = _mapping(recipe.get("lora"), "GRPO LoRA")
    limits = _mapping(recipe.get("resourceLimits"), "GRPO resource limits")
    policy_optimization = _mapping(
        recipe.get("policyOptimization"), "GRPO policy optimization"
    )
    policy_optimizer = _mapping(
        policy_optimization.get("optimizer"), "GRPO policy optimizer"
    )
    budget = _mapping(
        policy_optimization.get("budgets"), "GRPO policy budget"
    )
    manifest_model = _mapping(
        manifest.get("model"), "Harness Run Manifest model"
    )
    if (
        manifest_model.get("revision") != base_model.get("revision")
        or manifest_model.get("tokenizerRevision")
        != base_model.get("tokenizerRevision")
    ):
        raise PrimeRlExecutionError("prime_rl_model_lineage_mismatch")
    rank = _positive_int(lora.get("rank"), "LoRA rank")
    group_size = _positive_int(rollout.get("groupSize"), "rollout group size")
    if group_size < 2:
        raise PrimeRlExecutionError("prime_rl_group_size_invalid")
    if (
        policy_optimizer.get("method") != "grpo"
        or policy_optimizer.get("groupSize") != group_size
        or policy_optimizer.get("normalization") != "group_standardized"
    ):
        raise PrimeRlExecutionError(
            "prime_rl_policy_optimizer_mismatch"
        )
    loss = _mapping(recipe.get("loss"), "GRPO loss")
    if (
        loss.get("method") != "grpo"
        or policy_optimizer.get("loss") != "grpo"
        or loss.get("klBeta") is not None
    ):
        raise PrimeRlExecutionError("prime_rl_loss_unsupported")
    kl = _mapping(policy_optimization.get("kl"), "GRPO KL")
    if (
        kl.get("coefficient") is not None
        or kl.get("referenceConstraint") != "fixed_reference"
    ):
        raise PrimeRlExecutionError("prime_rl_kl_unsupported")
    policy_model = _mapping(
        policy_optimization.get("policyModel"), "GRPO policy model"
    )
    reference_model = _mapping(
        policy_optimization.get("referenceModel"), "GRPO reference model"
    )
    if policy_model != base_model or reference_model != base_model:
        raise PrimeRlExecutionError("prime_rl_policy_model_mismatch")
    sampler = _mapping(
        policy_optimization.get("sampler"), "GRPO sampler"
    )
    if any(
        sampler.get(policy_key) != rollout.get(recipe_key)
        for policy_key, recipe_key in (
            ("temperature", "temperature"),
            ("topP", "topP"),
            ("maxOutputTokens", "maxOutputTokens"),
            ("maxTurns", "maxTurns"),
            ("concurrency", "concurrency"),
        )
    ):
        raise PrimeRlExecutionError("prime_rl_sampler_mismatch")
    environment = _mapping(
        policy_optimization.get("environment"), "GRPO environment"
    )
    reward = _mapping(recipe.get("reward"), "GRPO reward")
    policy_reward = _mapping(
        policy_optimization.get("reward"), "GRPO policy reward"
    )
    if (
        environment.get("id") != reward.get("environmentId")
        or environment.get("version") != reward.get("environmentVersion")
        or environment.get("toolContractHash")
        != reward.get("toolContractHash")
        or policy_reward.get("graderId") != reward.get("graderId")
        or policy_reward.get("graderHash") != reward.get("graderHash")
    ):
        raise PrimeRlExecutionError(
            "prime_rl_environment_reward_mismatch"
        )
    maximum_steps = _positive_int(
        optimizer.get("maxSteps"), "optimizer maximum steps"
    )
    if budget.get("maxOptimizerSteps") != maximum_steps:
        raise PrimeRlExecutionError("prime_rl_optimizer_budget_mismatch")
    wall_time_ms = _positive_int(
        limits.get("wallTimeMs"), "worker wall time"
    )
    sequence_length = _positive_int(
        dataset.get("maxPromptTokens"), "maximum prompt tokens"
    ) + _positive_int(
        rollout.get("maxOutputTokens"), "maximum output tokens"
    )
    if sequence_length > 32_768:
        raise PrimeRlExecutionError("prime_rl_sequence_length_unsupported")
    learning_rate = _positive_float(
        optimizer.get("learningRate"), "learning rate"
    )
    checkpoint_every_steps = _positive_int(
        policy_optimization.get("checkpointEverySteps"),
        "checkpoint interval",
    )
    maximum_rollouts = _positive_int(
        budget.get("maxRollouts"), "maximum rollouts"
    )
    maximum_environment_executions = _positive_int(
        budget.get("maxEnvironmentExecutions"),
        "maximum environment executions",
    )
    required_rollouts = group_size * maximum_steps
    if (
        required_rollouts > maximum_rollouts
        or required_rollouts > maximum_environment_executions
        or required_rollouts
        * _positive_int(dataset.get("maxPromptTokens"), "maximum prompt tokens")
        > _positive_int(budget.get("maxInputTokens"), "maximum input tokens")
        or required_rollouts
        * _positive_int(rollout.get("maxOutputTokens"), "maximum output tokens")
        > _positive_int(budget.get("maxOutputTokens"), "maximum output tokens")
    ):
        raise PrimeRlExecutionError("prime_rl_rollout_budget_insufficient")
    maximum_cost = budget.get("maximumCostUsd")
    approved_maximum = plan.get("maximumSpendUsd")
    if maximum_cost is not None:
        maximum_cost = _nonnegative_float(
            maximum_cost, "maximum cost"
        )
        if (
            approved_maximum is None
            or maximum_cost
            > _nonnegative_float(approved_maximum, "approved maximum spend")
        ):
            raise PrimeRlExecutionError(
                "prime_rl_cost_budget_unapproved"
            )
    return PrimeRlSettings(
        model_id=_string(base_model.get("id"), "base model id"),
        model_revision=_string(
            base_model.get("revision"), "base model revision"
        ),
        tokenizer_revision=_string(
            base_model.get("tokenizerRevision"), "tokenizer revision"
        ),
        sequence_length=sequence_length,
        group_size=group_size,
        maximum_steps=maximum_steps,
        checkpoint_every_steps=checkpoint_every_steps,
        learning_rate=learning_rate,
        lora_rank=rank,
        lora_alpha=float(rank * 2),
        lora_dropout=0.0,
        wall_time_seconds=max(1, math.ceil(wall_time_ms / 1000)),
    )


def project_prime_rl_batch(
    *,
    plan: dict[str, Any],
    signal_values: list[dict[str, Any]],
    step: int,
) -> PrimeRlBatch:
    settings = resolve_prime_rl_settings(plan)
    manifest = _mapping(plan.get("manifest"), "resolved plan manifest")
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
    rewards = [_finite_float(record.get("reward"), "reward") for record in selected]
    reward_mean = sum(rewards) / len(rewards)
    centered_rewards = [reward - reward_mean for reward in rewards]
    reward_stddev = math.sqrt(
        sum(value * value for value in centered_rewards)
        / len(centered_rewards)
    )
    if reward_stddev <= 1e-12:
        raise PrimeRlExecutionError("prime_rl_training_group_constant_reward")
    advantages = [
        centered_reward / reward_stddev
        for centered_reward in centered_rewards
    ]
    projected: list[dict[str, Any]] = []
    lineage = []
    model_request_ids: set[str] = set()
    recipe = _mapping(plan.get("recipe"), "resolved plan recipe")
    recipe_reward = _mapping(recipe.get("reward"), "GRPO reward")
    dataset = _mapping(recipe.get("dataset"), "GRPO dataset")
    rollout = _mapping(recipe.get("rollout"), "GRPO rollout")
    for record, reward, advantage in zip(
        selected, rewards, advantages, strict=True
    ):
        sample = _mapping(
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
            (
                "toolContractHash",
                recipe_reward.get("toolContractHash"),
            ),
        ):
            for source in ("trajectoryLineage", "rewardLineage"):
                signal_lineage = _mapping(
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


def render_prime_rl_trainer_config(
    *,
    settings: PrimeRlSettings,
    model_path: Path,
    output_root: Path,
    step: int,
    manifest_hash: str,
) -> str:
    lines = [
        f"max_steps = {step}",
        f"output_dir = {toml_string(str(output_root))}",
        "max_concurrent_runs = 1",
        "enable_token_export = true",
        "",
        "[model]",
        f"name = {toml_string(str(model_path))}",
        f"seq_len = {settings.sequence_length}",
        'impl = "hf"',
        'attn = "flash_attention_2"',
        'compile = "None"',
        "optim_cpu_offload = false",
        "",
        "[model.lora]",
        f"rank = {settings.lora_rank}",
        f"alpha = {settings.lora_alpha:g}",
        f"dropout = {settings.lora_dropout:.1f}",
        "",
        "[optim]",
        'type = "adamw"',
        f"lr = {settings.learning_rate:g}",
        "",
        "[ckpt]",
        "interval = 1",
        "keep_last = 2",
    ]
    if step > 1:
        lines.append(f"resume_step = {step - 1}")
    lines.extend(
        [
            "",
            "[ckpt.weights]",
            "save_adapter_separately = true",
            "",
            "[weight_broadcast]",
            'type = "filesystem"',
            "",
            "[rollout_transport]",
            'type = "filesystem"',
            "",
            "[env_vars]",
            'TOKENIZERS_PARALLELISM = "false"',
            'WANDB_DISABLED = "true"',
            "",
            "# Provenance (validated before launch)",
            f"# prime_rl_commit = {PRIME_RL_UPSTREAM_REVISION}",
            f"# base_model_revision = {settings.model_revision}",
            f"# tokenizer_revision = {settings.tokenizer_revision}",
            f"# harness_run_manifest_sha256 = {manifest_hash}",
            f"# requested_checkpoint_interval = {settings.checkpoint_every_steps}",
            "",
        ]
    )
    return "\n".join(lines)


def render_prime_rl_run_config(
    *,
    settings: PrimeRlSettings,
    model_path: Path,
    output_root: Path,
    step: int,
) -> str:
    lines = [
        f"output_dir = {toml_string(str(output_root / 'run_default'))}",
        f"max_steps = {settings.maximum_steps}",
        f"seq_len = {settings.sequence_length}",
        f"batch_size = {settings.group_size}",
        f"group_size = {settings.group_size}",
        "max_off_policy_steps = 0",
        "",
        "[model]",
        f"name = {toml_string(str(model_path))}",
        "",
        "[model.lora]",
        'name = "candidate"',
        f"rank = {settings.lora_rank}",
        f"alpha = {settings.lora_alpha:g}",
        "",
        "[optim]",
        f"lr = {settings.learning_rate:g}",
        "",
        "[algo]",
        'type = "grpo"',
        "",
        "[ckpt]",
        f"interval = {settings.checkpoint_every_steps}",
    ]
    if step > 1:
        lines.append(f"resume_step = {step - 1}")
    lines.extend(
        [
            "",
            "[weight_broadcast]",
            'type = "filesystem"',
            "",
        ]
    )
    return "\n".join(lines)


def materialize_pinned_model(
    *,
    settings: PrimeRlSettings,
    model_root: Path,
    run_process: Callable[..., subprocess.CompletedProcess[Any]] = subprocess.run,
) -> Path:
    identity = hashlib.sha256(
        (
            f"{settings.model_id}@{settings.model_revision}"
            f"#tokenizer={settings.tokenizer_revision}"
        ).encode()
    ).hexdigest()[:24]
    model_root.mkdir(parents=True, exist_ok=True)
    lock_path = model_root / f"{identity}.lock"
    with lock_path.open("a", encoding="utf-8") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            return _materialize_pinned_model_locked(
                settings=settings,
                model_root=model_root,
                identity=identity,
                run_process=run_process,
            )
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def _materialize_pinned_model_locked(
    *,
    settings: PrimeRlSettings,
    model_root: Path,
    identity: str,
    run_process: Callable[..., subprocess.CompletedProcess[Any]],
) -> Path:
    model_path = model_root / identity
    receipt = model_path / "openpond-model-receipt.json"
    if receipt.is_file():
        value = json.loads(receipt.read_text(encoding="utf-8"))
        if (
            value.get("modelId") == settings.model_id
            and value.get("revision") == settings.model_revision
            and (model_path / "config.json").is_file()
        ):
            return model_path
        raise PrimeRlExecutionError("prime_rl_model_cache_lineage_mismatch")
    model_path.mkdir(parents=True, exist_ok=True)
    result = run_process(
        [
            "uv",
            "run",
            "--no-sync",
            "hf",
            "download",
            settings.model_id,
            "--revision",
            settings.model_revision,
            "--local-dir",
            str(model_path),
        ],
        check=False,
    )
    if result.returncode != 0 or not (model_path / "config.json").is_file():
        raise PrimeRlExecutionError("prime_rl_model_materialization_failed")
    if settings.tokenizer_revision != settings.model_revision:
        tokenizer_overlay = model_root / f".{identity}-tokenizer"
        shutil.rmtree(tokenizer_overlay, ignore_errors=True)
        tokenizer_result = run_process(
            [
                "uv",
                "run",
                "--no-sync",
                "hf",
                "download",
                settings.model_id,
                "--revision",
                settings.tokenizer_revision,
                "--include",
                "tokenizer*",
                "special_tokens_map.json",
                "added_tokens.json",
                "vocab*",
                "merges.txt",
                "*.model",
                "chat_template*",
                "--local-dir",
                str(tokenizer_overlay),
            ],
            check=False,
        )
        tokenizer_files = [
            path
            for path in tokenizer_overlay.rglob("*")
            if path.is_file() and ".cache" not in path.parts
        ]
        if tokenizer_result.returncode != 0 or not tokenizer_files:
            shutil.rmtree(tokenizer_overlay, ignore_errors=True)
            raise PrimeRlExecutionError(
                "prime_rl_tokenizer_materialization_failed"
            )
        for source in tokenizer_files:
            relative = source.relative_to(tokenizer_overlay)
            target = model_path / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
        shutil.rmtree(tokenizer_overlay)
    receipt.write_text(
        json.dumps(
            {
                "schemaVersion": "openpond.modelMaterializationReceipt.v1",
                "modelId": settings.model_id,
                "revision": settings.model_revision,
                "tokenizerRevision": settings.tokenizer_revision,
            },
            sort_keys=True,
        ),
        encoding="utf-8",
    )
    return model_path


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


def execute_prime_rl_step(
    *,
    plan: dict[str, Any],
    settings: PrimeRlSettings,
    batch: PrimeRlBatch,
    engine_root: Path,
    output_directory: Path,
    model_path: Path,
    timeout_seconds: int,
    run_process: Callable[..., subprocess.CompletedProcess[Any]] = subprocess.run,
    cancelled: Callable[[], bool] | None = None,
) -> dict[str, Any]:
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
    write_prime_rl_batch(batch_path, batch)
    command = [
        "uv",
        "run",
        "--no-sync",
        "torchrun",
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
        return_code = run_cancellable_command(
            command,
            cwd=engine_root,
            timeout_seconds=timeout_seconds,
            cancelled=cancelled,
        )
    if return_code == 130:
        raise PrimeRlExecutionError("prime_rl_cancelled")
    if return_code != 0:
        raise PrimeRlExecutionError("prime_rl_trainer_step_failed")
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
        "checkpointContentHash": directory_content_hash(
            checkpoint_target
        ),
    }
    receipt = {**receipt, "contentHash": content_hash(receipt)}
    receipt_path = output_directory / "prime-rl-step-receipts.jsonl"
    with receipt_path.open("a", encoding="utf-8") as file:
        file.write(json.dumps(receipt, sort_keys=True) + "\n")
        file.flush()
        os.fsync(file.fileno())
    return receipt


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


def run_cancellable_command(
    command: list[str],
    *,
    cwd: Path,
    timeout_seconds: int,
    cancelled: Callable[[], bool],
) -> int:
    process = subprocess.Popen(
        command,
        cwd=cwd,
        start_new_session=True,
    )
    deadline = time.monotonic() + timeout_seconds
    while True:
        code = process.poll()
        if code is not None:
            return code
        if cancelled():
            _terminate_process_group(process)
            return 130
        if time.monotonic() >= deadline:
            _terminate_process_group(process)
            raise PrimeRlExecutionError("prime_rl_trainer_step_timeout")
        time.sleep(0.25)


def _terminate_process_group(process: subprocess.Popen[Any]) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=15)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=5)


def content_hash(value: Any) -> str:
    canonical = json.dumps(
        value, sort_keys=True, ensure_ascii=False, indent=2
    ) + "\n"
    return hashlib.sha256(canonical.encode()).hexdigest()


def _validate_hashed_object(
    value: dict[str, Any], error_code: str
) -> None:
    supplied = value.get("contentHash")
    content = {
        key: item for key, item in value.items() if key != "contentHash"
    }
    if not isinstance(supplied, str) or supplied != content_hash(content):
        raise PrimeRlExecutionError(error_code)


def toml_string(value: str) -> str:
    return json.dumps(value)


def _mapping(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise PrimeRlExecutionError(
            f"prime_rl_{label.lower().replace(' ', '_')}_invalid"
        )
    return value


def _string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise PrimeRlExecutionError(
            f"prime_rl_{label.lower().replace(' ', '_')}_invalid"
        )
    return value


def _positive_int(value: Any, label: str) -> int:
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or value <= 0
    ):
        raise PrimeRlExecutionError(
            f"prime_rl_{label.lower().replace(' ', '_')}_invalid"
        )
    return value


def _positive_float(value: Any, label: str) -> float:
    result = _finite_float(value, label)
    if result <= 0:
        raise PrimeRlExecutionError(
            f"prime_rl_{label.lower().replace(' ', '_')}_invalid"
        )
    return result


def _nonnegative_float(value: Any, label: str) -> float:
    result = _finite_float(value, label)
    if result < 0:
        raise PrimeRlExecutionError(
            f"prime_rl_{label.lower().replace(' ', '_')}_invalid"
        )
    return result


def _finite_float(value: Any, label: str) -> float:
    if (
        not isinstance(value, (int, float))
        or isinstance(value, bool)
        or not math.isfinite(float(value))
    ):
        raise PrimeRlExecutionError(
            f"prime_rl_{label.lower().replace(' ', '_')}_invalid"
        )
    return float(value)


def _worker_digest(value: Any) -> bool:
    return (
        isinstance(value, str)
        and value.startswith("sha256:")
        and len(value) == 71
        and all(character in "0123456789abcdef" for character in value[7:])
    )
