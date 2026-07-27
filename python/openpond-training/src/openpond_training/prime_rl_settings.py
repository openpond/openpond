from __future__ import annotations

import math
from typing import Any

from .canonical_json import content_hash
from .engine_adapters import PRIME_RL_UPSTREAM_REVISION
from .prime_rl_contracts import PrimeRlExecutionError, PrimeRlSettings
from .prime_rl_values import (
    mapping,
    nonnegative_float,
    positive_float,
    positive_int,
    string,
    validate_hashed_object,
    worker_digest,
)


def resolve_prime_rl_settings(plan: dict[str, Any]) -> PrimeRlSettings:
    validate_hashed_object(plan, "prime_rl_resolved_plan_hash_mismatch")
    manifest = mapping(plan.get("manifest"), "resolved plan manifest")
    validate_hashed_object(manifest, "prime_rl_manifest_hash_mismatch")
    engine = mapping(plan.get("engine"), "resolved plan engine")
    manifest_engine = mapping(
        manifest.get("engine"), "Harness Run Manifest engine"
    )
    if engine != manifest_engine:
        raise PrimeRlExecutionError("prime_rl_engine_lineage_mismatch")
    recipe = mapping(plan.get("recipe"), "resolved plan recipe")
    if engine.get("adapterId") != "connected-prime-rl":
        raise PrimeRlExecutionError("prime_rl_engine_adapter_mismatch")
    if engine.get("upstreamRevision") != PRIME_RL_UPSTREAM_REVISION:
        raise PrimeRlExecutionError("prime_rl_upstream_revision_mismatch")
    if not worker_digest(engine.get("workerImageDigest")):
        raise PrimeRlExecutionError("prime_rl_worker_image_mismatch")
    if recipe.get("method") != "grpo":
        raise PrimeRlExecutionError("prime_rl_recipe_method_unsupported")
    manifest_recipe = mapping(
        manifest.get("recipe"), "Harness Run Manifest recipe"
    )
    if manifest_recipe.get("method") != "grpo":
        raise PrimeRlExecutionError("prime_rl_manifest_method_mismatch")
    if manifest_recipe.get("configHash") != content_hash(recipe):
        raise PrimeRlExecutionError("prime_rl_recipe_hash_mismatch")

    base_model = mapping(recipe.get("baseModel"), "GRPO base model")
    optimizer = mapping(recipe.get("optimizer"), "GRPO optimizer")
    rollout = mapping(recipe.get("rollout"), "GRPO rollout")
    dataset = mapping(recipe.get("dataset"), "GRPO dataset")
    lora = mapping(recipe.get("lora"), "GRPO LoRA")
    limits = mapping(recipe.get("resourceLimits"), "GRPO resource limits")
    policy_optimization = mapping(
        recipe.get("policyOptimization"), "GRPO policy optimization"
    )
    policy_optimizer = mapping(
        policy_optimization.get("optimizer"), "GRPO policy optimizer"
    )
    budget = mapping(
        policy_optimization.get("budgets"), "GRPO policy budget"
    )
    manifest_model = mapping(
        manifest.get("model"), "Harness Run Manifest model"
    )
    if (
        manifest_model.get("revision") != base_model.get("revision")
        or manifest_model.get("tokenizerRevision")
        != base_model.get("tokenizerRevision")
    ):
        raise PrimeRlExecutionError("prime_rl_model_lineage_mismatch")
    rank = positive_int(lora.get("rank"), "LoRA rank")
    group_size = positive_int(rollout.get("groupSize"), "rollout group size")
    if group_size < 2:
        raise PrimeRlExecutionError("prime_rl_group_size_invalid")
    if (
        policy_optimizer.get("method") != "grpo"
        or policy_optimizer.get("groupSize") != group_size
        or policy_optimizer.get("normalization") != "group_standardized"
    ):
        raise PrimeRlExecutionError("prime_rl_policy_optimizer_mismatch")
    loss = mapping(recipe.get("loss"), "GRPO loss")
    if (
        loss.get("method") != "grpo"
        or policy_optimizer.get("loss") != "grpo"
        or loss.get("klBeta") is not None
    ):
        raise PrimeRlExecutionError("prime_rl_loss_unsupported")
    kl = mapping(policy_optimization.get("kl"), "GRPO KL")
    if (
        kl.get("coefficient") is not None
        or kl.get("referenceConstraint") != "fixed_reference"
    ):
        raise PrimeRlExecutionError("prime_rl_kl_unsupported")
    policy_model = mapping(
        policy_optimization.get("policyModel"), "GRPO policy model"
    )
    reference_model = mapping(
        policy_optimization.get("referenceModel"), "GRPO reference model"
    )
    if policy_model != base_model or reference_model != base_model:
        raise PrimeRlExecutionError("prime_rl_policy_model_mismatch")
    sampler = mapping(
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
    environment = mapping(
        policy_optimization.get("environment"), "GRPO environment"
    )
    reward = mapping(recipe.get("reward"), "GRPO reward")
    policy_reward = mapping(
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
    maximum_steps = positive_int(
        optimizer.get("maxSteps"), "optimizer maximum steps"
    )
    if budget.get("maxOptimizerSteps") != maximum_steps:
        raise PrimeRlExecutionError("prime_rl_optimizer_budget_mismatch")
    wall_time_ms = positive_int(
        limits.get("wallTimeMs"), "worker wall time"
    )
    sequence_length = positive_int(
        dataset.get("maxPromptTokens"), "maximum prompt tokens"
    ) + positive_int(
        rollout.get("maxOutputTokens"), "maximum output tokens"
    )
    if sequence_length > 32_768:
        raise PrimeRlExecutionError("prime_rl_sequence_length_unsupported")
    learning_rate = positive_float(
        optimizer.get("learningRate"), "learning rate"
    )
    checkpoint_every_steps = positive_int(
        policy_optimization.get("checkpointEverySteps"),
        "checkpoint interval",
    )
    maximum_rollouts = positive_int(
        budget.get("maxRollouts"), "maximum rollouts"
    )
    maximum_environment_executions = positive_int(
        budget.get("maxEnvironmentExecutions"),
        "maximum environment executions",
    )
    required_rollouts = group_size * maximum_steps
    if (
        required_rollouts > maximum_rollouts
        or required_rollouts > maximum_environment_executions
        or required_rollouts
        * positive_int(dataset.get("maxPromptTokens"), "maximum prompt tokens")
        > positive_int(budget.get("maxInputTokens"), "maximum input tokens")
        or required_rollouts
        * positive_int(rollout.get("maxOutputTokens"), "maximum output tokens")
        > positive_int(budget.get("maxOutputTokens"), "maximum output tokens")
    ):
        raise PrimeRlExecutionError("prime_rl_rollout_budget_insufficient")
    maximum_cost = budget.get("maximumCostUsd")
    approved_maximum = plan.get("maximumSpendUsd")
    if maximum_cost is not None:
        maximum_cost = nonnegative_float(maximum_cost, "maximum cost")
        if (
            approved_maximum is None
            or maximum_cost
            > nonnegative_float(approved_maximum, "approved maximum spend")
        ):
            raise PrimeRlExecutionError(
                "prime_rl_cost_budget_unapproved"
            )
    return PrimeRlSettings(
        model_id=string(base_model.get("id"), "base model id"),
        model_revision=string(
            base_model.get("revision"), "base model revision"
        ),
        tokenizer_revision=string(
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
