from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path
from typing import Any, Callable

import torch
from peft import get_peft_model
from safetensors.torch import load_file, save_file

from .artifacts import build_artifact_manifest
from .contracts import ContractError
from .events import EventWriter
from .fixture_model import lora_config
from .model_runtime import (
    input_text,
    load_base_model,
    recipe_base_model,
    reload_adapter,
    render_evaluation_prompt,
)


def run_ppo_training(
    *,
    args: Any,
    manifest: dict[str, Any],
    recipe: dict[str, Any],
    records: list[dict[str, Any]],
    writer: EventWriter,
    temporary_directory: Path,
    cancelled: Callable[[], bool],
    run_frozen_evaluation: Callable[..., None],
) -> int:
    if not args.taskset:
        raise ContractError("PPO requires the local Taskset for verifier rewards.")
    taskset = json.loads(Path(args.taskset).resolve().read_text(encoding="utf-8"))
    task_by_id = {task["id"]: task for task in taskset.get("tasks", [])}
    contract = recipe["policyOptimization"]
    optimizer_contract = contract["optimizer"]
    limits = recipe["resourceLimits"]
    budgets = contract["budgets"]
    seed = int(contract["seed"])
    torch.manual_seed(seed)
    torch.set_num_threads(max(1, int(limits["cpuThreads"])))
    model_path = getattr(args, "model_path", None)
    base_model = recipe_base_model(recipe)
    policy_base, tokenizer, template_hash = load_base_model(
        {"method": "dpo", "policyModel": base_model},
        records,
        seed,
        model_path,
    )
    reference_model, _, reference_template_hash = load_base_model(
        {"method": "dpo", "policyModel": contract["referenceModel"]},
        records,
        seed,
        model_path,
    )
    if template_hash != reference_template_hash:
        raise ContractError("PPO policy and reference chat templates differ.")
    if base_model["chatTemplateHash"] not in {template_hash, "fixture00000000"}:
        raise ContractError("PPO policy chat-template hash does not match the recipe.")
    reference_model.eval()
    for parameter in reference_model.parameters():
        parameter.requires_grad_(False)
    policy = get_peft_model(policy_base, lora_config(recipe))
    hidden_size = int(policy.config.hidden_size)
    value_head = torch.nn.Linear(hidden_size, 1)
    policy_optimizer = torch.optim.AdamW(
        [parameter for parameter in policy.parameters() if parameter.requires_grad],
        lr=float(recipe.get("policyLearningRate", 1e-3)),
    )
    value_optimizer = torch.optim.AdamW(
        value_head.parameters(),
        lr=float(recipe["valueHead"]["optimizerLearningRate"]),
    )
    start_step = restore_checkpoint(
        getattr(args, "checkpoint_path", None),
        recipe,
        policy,
        value_head,
        policy_optimizer,
        value_optimizer,
    )
    output_directory = Path(args.output).resolve()
    deadline = time.monotonic() + int(limits["wallTimeMs"]) / 1000
    maximum_steps = int(budgets["maxOptimizerSteps"])
    maximum_rollouts = int(budgets["maxRollouts"])
    maximum_environment_executions = int(budgets["maxEnvironmentExecutions"])
    maximum_input_tokens = int(budgets["maxInputTokens"])
    maximum_output_tokens = int(budgets["maxOutputTokens"])
    optimizer_steps = start_step
    rollout_count = 0
    environment_executions = 0
    input_tokens = 0
    output_tokens = 0
    trajectory_rows: list[dict[str, Any]] = []
    metric_rows: list[dict[str, Any]] = []
    started_at = time.monotonic()

    run_frozen_evaluation(
        taskset_path=Path(args.taskset).resolve(),
        model=reference_model,
        tokenizer=tokenizer,
        output_path=output_directory / "base-frozen-eval-predictions.jsonl",
        seed=seed,
    )
    while optimizer_steps < maximum_steps:
        ensure_active(cancelled, deadline)
        record = records[optimizer_steps % len(records)]
        task = task_by_id.get(record["id"])
        if not task:
            raise ContractError(f"PPO record {record['id']} has no Taskset task.")
        expected_text = expected_output_text(task)
        prompt = render_evaluation_prompt(record.get("input", {}), tokenizer)
        encoded = tokenizer(prompt, return_tensors="pt", truncation=True, max_length=96)
        expected_ids = tokenizer(
            expected_text,
            add_special_tokens=False,
            truncation=True,
            max_length=int(contract["sampler"]["maxOutputTokens"]),
        )["input_ids"]
        if not expected_ids:
            raise ContractError(f"PPO verifier target for {record['id']} is empty.")
        if rollout_count + 1 > maximum_rollouts:
            raise RuntimeError("PPO rollout budget exhausted.")
        if environment_executions + 1 > maximum_environment_executions:
            raise RuntimeError("PPO environment-execution budget exhausted.")
        if input_tokens + int(encoded["input_ids"].numel()) > maximum_input_tokens:
            raise RuntimeError("PPO input-token budget exhausted.")
        action_limit = min(
            len(expected_ids),
            int(contract["sampler"]["maxOutputTokens"]),
            maximum_output_tokens - output_tokens,
        )
        if action_limit <= 0:
            raise RuntimeError("PPO output-token budget exhausted.")
        sampled = sample_trajectory(
            policy=policy,
            reference_model=reference_model,
            value_head=value_head,
            input_ids=encoded["input_ids"],
            attention_mask=encoded["attention_mask"],
            expected_ids=expected_ids[:action_limit],
            temperature=float(contract["sampler"]["temperature"]),
            cancelled=cancelled,
            deadline=deadline,
        )
        rollout_count += 1
        environment_executions += 1
        input_tokens += int(encoded["input_ids"].numel())
        output_tokens += len(sampled["action_ids"])
        reward = deterministic_token_reward(sampled["action_ids"], expected_ids[:action_limit])
        rewards = [0.0] * len(sampled["action_ids"])
        rewards[-1] = reward
        returns, advantages = generalized_advantage_estimation(
            rewards,
            sampled["old_values"],
            gamma=float(optimizer_contract["gamma"]),
            gae_lambda=float(optimizer_contract["gaeLambda"]),
        )
        update = ppo_update(
            policy=policy,
            reference_model=reference_model,
            value_head=value_head,
            policy_optimizer=policy_optimizer,
            value_optimizer=value_optimizer,
            prefixes=sampled["prefixes"],
            attention_masks=sampled["attention_masks"],
            actions=sampled["action_ids"],
            old_log_probabilities=sampled["old_log_probabilities"],
            reference_log_probabilities=sampled["reference_log_probabilities"],
            old_values=sampled["old_values"],
            returns=returns,
            advantages=advantages,
            policy_clip=float(optimizer_contract["policyClip"]),
            value_clip=float(optimizer_contract["valueClip"]),
            value_loss_coefficient=float(optimizer_contract["valueLossCoefficient"]),
            ppo_epochs=int(optimizer_contract["ppoEpochs"]),
            cancelled=cancelled,
            deadline=deadline,
        )
        optimizer_steps += 1
        trajectory = trajectory_receipt(
            recipe=recipe,
            task_id=record["id"],
            index=rollout_count,
            prefixes=sampled["prefixes"],
            actions=sampled["action_ids"],
            rewards=rewards,
            old_log_probabilities=sampled["old_log_probabilities"],
            reference_log_probabilities=sampled["reference_log_probabilities"],
            old_values=sampled["old_values"],
            returns=returns,
            advantages=advantages,
        )
        trajectory_rows.append(trajectory)
        metric = {
            "schemaVersion": "openpond.policyOptimizationMetric.v1",
            "method": "ppo",
            "step": optimizer_steps,
            "timestamp": utc_now(),
            "policyLoss": update["policyLoss"],
            "valueLoss": update["valueLoss"],
            "meanReward": reward,
            "meanReturn": sum(returns) / len(returns),
            "kl": update["kl"],
            "entropy": update["entropy"],
            "policyClipFraction": update["policyClipFraction"],
            "valueClipFraction": update["valueClipFraction"],
            "explainedVariance": explained_variance(returns, sampled["old_values"]),
            "rolloutLearnerLag": 0,
            "inputTokens": input_tokens,
            "outputTokens": output_tokens,
            "environmentExecutions": environment_executions,
            "costUsd": 0,
        }
        metric_rows.append(metric)
        writer.emit("metric", {"metricKind": "policy_optimization", **metric})
        writer.emit("progress", {
            "step": optimizer_steps,
            "maxSteps": maximum_steps,
            "rollouts": rollout_count,
            "environmentExecutions": environment_executions,
        })
        write_jsonl(output_directory / "ppo-trajectories.jsonl", trajectory_rows)
        write_jsonl(output_directory / "policy-metrics.jsonl", metric_rows)
        save_checkpoint(
            output_directory / "checkpoints" / f"step-{optimizer_steps}",
            recipe,
            optimizer_steps,
            policy,
            value_head,
            policy_optimizer,
            value_optimizer,
        )

    adapter_directory = output_directory / "adapter"
    policy.save_pretrained(adapter_directory, safe_serialization=True)
    tokenizer.save_pretrained(output_directory / "tokenizer")
    save_file(
        {name: tensor.detach().cpu() for name, tensor in value_head.state_dict().items()},
        str(output_directory / "value_head.safetensors"),
    )
    reloaded, reloaded_tokenizer, reloaded_template_hash = reload_adapter(
        adapter_directory,
        {"method": "dpo", "policyModel": base_model},
        records,
        seed,
        model_path,
    )
    run_frozen_evaluation(
        taskset_path=Path(args.taskset).resolve(),
        model=reloaded,
        tokenizer=reloaded_tokenizer,
        output_path=output_directory / "frozen-eval-predictions.jsonl",
        seed=seed,
    )
    metrics = {
        "method": "ppo",
        "steps": optimizer_steps,
        "rollouts": rollout_count,
        "environmentExecutions": environment_executions,
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "meanReward": sum(item["meanReward"] for item in metric_rows) / len(metric_rows),
        "elapsedSeconds": time.monotonic() - started_at,
        "policyHash": recipe["resume"]["policyHash"],
        "referenceHash": recipe["resume"]["referenceHash"],
        "valueModelHash": recipe["resume"]["valueModelHash"],
        "reloadVerified": True,
    }
    (output_directory / "metrics.json").write_text(
        json.dumps(metrics, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    tokenizer_hash = hashlib.sha256(
        reloaded_tokenizer.backend_tokenizer.to_str().encode("utf-8")
    ).hexdigest()
    artifact_manifest = build_artifact_manifest(
        job_id=args.job_id,
        output_directory=output_directory,
        base_model_id=base_model["id"],
        base_revision=base_model["revision"],
        tokenizer_revision=base_model["tokenizerRevision"],
        tokenizer_hash=tokenizer_hash,
        chat_template_hash=reloaded_template_hash,
        metadata={
            "bundleHash": manifest["contentHash"],
            "recipeHash": manifest["recipeHash"],
            "seed": seed,
            "reloadVerified": True,
            "baseAndAdapterEvaluation": True,
            "criticArtifact": "value_head.safetensors",
            **metrics,
        },
    )
    writer.emit("complete", {
        "artifactManifest": str(output_directory / "artifact-manifest.json"),
        "artifactCount": len(artifact_manifest["artifacts"]),
        "nonProduction": True,
        "method": "ppo",
    })
    return 0


def sample_trajectory(
    *,
    policy: torch.nn.Module,
    reference_model: torch.nn.Module,
    value_head: torch.nn.Module,
    input_ids: torch.Tensor,
    attention_mask: torch.Tensor,
    expected_ids: list[int],
    temperature: float,
    cancelled: Callable[[], bool],
    deadline: float,
) -> dict[str, Any]:
    prefixes: list[torch.Tensor] = []
    masks: list[torch.Tensor] = []
    actions: list[int] = []
    old_logps: list[float] = []
    reference_logps: list[float] = []
    old_values: list[float] = []
    current_ids = input_ids.clone()
    current_mask = attention_mask.clone()
    policy.eval()
    for _ in expected_ids:
        ensure_active(cancelled, deadline)
        with torch.no_grad():
            output = policy(
                input_ids=current_ids,
                attention_mask=current_mask,
                output_hidden_states=True,
            )
            logits = output.logits[:, -1, :] / max(temperature, 1e-5)
            distribution = torch.distributions.Categorical(logits=logits)
            action = distribution.sample()
            old_logp = distribution.log_prob(action)
            hidden = output.hidden_states[-1][:, -1, :]
            old_value = value_head(hidden).squeeze(-1)
            reference = reference_model(
                input_ids=current_ids,
                attention_mask=current_mask,
            )
            reference_distribution = torch.distributions.Categorical(
                logits=reference.logits[:, -1, :] / max(temperature, 1e-5)
            )
            reference_logp = reference_distribution.log_prob(action)
        prefixes.append(current_ids.clone())
        masks.append(current_mask.clone())
        action_id = int(action.item())
        actions.append(action_id)
        old_logps.append(float(old_logp.item()))
        reference_logps.append(float(reference_logp.item()))
        old_values.append(float(old_value.item()))
        current_ids = torch.cat([current_ids, action.view(1, 1)], dim=1)
        current_mask = torch.cat(
            [current_mask, torch.ones((1, 1), dtype=current_mask.dtype)],
            dim=1,
        )
    policy.train()
    return {
        "prefixes": prefixes,
        "attention_masks": masks,
        "action_ids": actions,
        "old_log_probabilities": old_logps,
        "reference_log_probabilities": reference_logps,
        "old_values": old_values,
    }


def ppo_update(
    *,
    policy: torch.nn.Module,
    reference_model: torch.nn.Module,
    value_head: torch.nn.Module,
    policy_optimizer: torch.optim.Optimizer,
    value_optimizer: torch.optim.Optimizer,
    prefixes: list[torch.Tensor],
    attention_masks: list[torch.Tensor],
    actions: list[int],
    old_log_probabilities: list[float],
    reference_log_probabilities: list[float],
    old_values: list[float],
    returns: list[float],
    advantages: list[float],
    policy_clip: float,
    value_clip: float,
    value_loss_coefficient: float,
    ppo_epochs: int,
    cancelled: Callable[[], bool],
    deadline: float,
) -> dict[str, float]:
    normalized_advantages = normalize(advantages)
    latest: dict[str, float] = {}
    for _ in range(ppo_epochs):
        ensure_active(cancelled, deadline)
        policy_losses = []
        value_losses = []
        entropies = []
        kls = []
        policy_clips = []
        value_clips = []
        for index, prefix in enumerate(prefixes):
            output = policy(
                input_ids=prefix,
                attention_mask=attention_masks[index],
                output_hidden_states=True,
            )
            distribution = torch.distributions.Categorical(
                logits=output.logits[:, -1, :]
            )
            action = torch.tensor([actions[index]], dtype=torch.long)
            logp = distribution.log_prob(action)
            ratio = torch.exp(logp - old_log_probabilities[index])
            advantage = torch.tensor(normalized_advantages[index])
            unclipped = ratio * advantage
            clipped = torch.clamp(ratio, 1 - policy_clip, 1 + policy_clip) * advantage
            policy_losses.append(-torch.minimum(unclipped, clipped).mean())
            policy_clips.append(float((torch.abs(ratio - 1) > policy_clip).float().mean().item()))
            hidden = output.hidden_states[-1][:, -1, :]
            value = value_head(hidden).squeeze(-1)
            old_value = torch.tensor([old_values[index]])
            target_return = torch.tensor([returns[index]])
            clipped_value = old_value + torch.clamp(value - old_value, -value_clip, value_clip)
            plain_value_loss = torch.square(value - target_return)
            clipped_value_loss = torch.square(clipped_value - target_return)
            value_losses.append(0.5 * torch.maximum(plain_value_loss, clipped_value_loss).mean())
            value_clips.append(float((torch.abs(value - old_value) > value_clip).float().mean().item()))
            entropies.append(distribution.entropy().mean())
            kls.append((logp - reference_log_probabilities[index]).mean())
        policy_loss = torch.stack(policy_losses).mean()
        value_loss = torch.stack(value_losses).mean()
        entropy = torch.stack(entropies).mean()
        total = policy_loss + value_loss_coefficient * value_loss
        policy_optimizer.zero_grad()
        value_optimizer.zero_grad()
        total.backward()
        torch.nn.utils.clip_grad_norm_(
            [parameter for parameter in policy.parameters() if parameter.requires_grad],
            1.0,
        )
        torch.nn.utils.clip_grad_norm_(value_head.parameters(), 1.0)
        policy_optimizer.step()
        value_optimizer.step()
        latest = {
            "policyLoss": float(policy_loss.detach().item()),
            "valueLoss": float(value_loss.detach().item()),
            "kl": float(torch.stack(kls).mean().detach().item()),
            "entropy": float(entropy.detach().item()),
            "policyClipFraction": sum(policy_clips) / len(policy_clips),
            "valueClipFraction": sum(value_clips) / len(value_clips),
        }
    return latest


def generalized_advantage_estimation(
    rewards: list[float],
    values: list[float],
    *,
    gamma: float,
    gae_lambda: float,
) -> tuple[list[float], list[float]]:
    advantages = [0.0] * len(rewards)
    accumulator = 0.0
    for index in range(len(rewards) - 1, -1, -1):
        next_value = values[index + 1] if index + 1 < len(values) else 0.0
        delta = rewards[index] + gamma * next_value - values[index]
        accumulator = delta + gamma * gae_lambda * accumulator
        advantages[index] = accumulator
    returns = [advantages[index] + values[index] for index in range(len(values))]
    return returns, advantages


def deterministic_token_reward(actions: list[int], expected: list[int]) -> float:
    if not expected:
        return 0.0
    return sum(int(left == right) for left, right in zip(actions, expected)) / len(expected)


def trajectory_receipt(
    *,
    recipe: dict[str, Any],
    task_id: str,
    index: int,
    prefixes: list[torch.Tensor],
    actions: list[int],
    rewards: list[float],
    old_log_probabilities: list[float],
    reference_log_probabilities: list[float],
    old_values: list[float],
    returns: list[float],
    advantages: list[float],
) -> dict[str, Any]:
    contract = recipe["policyOptimization"]
    return {
        "schemaVersion": "openpond.ppoTrajectory.v1",
        "id": f"ppo_trajectory_{index}",
        "taskId": task_id,
        "policyModelId": contract["policyModel"]["id"],
        "referenceModelId": contract["referenceModel"]["id"],
        "valueModelId": contract["optimizer"]["valueModel"]["id"],
        "steps": [
            {
                "index": step,
                "observationHash": hashlib.sha256(prefix.numpy().tobytes()).hexdigest(),
                "actionTokenIds": [actions[step]],
                "terminated": step == len(actions) - 1,
                "truncated": False,
                "reward": rewards[step],
                "policyLogProbability": old_log_probabilities[step],
                "referenceLogProbability": reference_log_probabilities[step],
                "valuePrediction": old_values[step],
                "return": returns[step],
                "advantage": advantages[step],
                "mask": 1,
            }
            for step, prefix in enumerate(prefixes)
        ],
        "createdAt": utc_now(),
    }


def save_checkpoint(
    directory: Path,
    recipe: dict[str, Any],
    step: int,
    policy: torch.nn.Module,
    value_head: torch.nn.Module,
    policy_optimizer: torch.optim.Optimizer,
    value_optimizer: torch.optim.Optimizer,
) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    policy.save_pretrained(directory / "adapter", safe_serialization=True)
    save_file(
        {name: tensor.detach().cpu() for name, tensor in value_head.state_dict().items()},
        str(directory / "value_head.safetensors"),
    )
    torch.save({
        "policy": policy_optimizer.state_dict(),
        "value": value_optimizer.state_dict(),
    }, directory / "optimizer.pt")
    (directory / "checkpoint.json").write_text(json.dumps({
        "schemaVersion": "openpond.ppoCheckpoint.v1",
        "step": step,
        "policyHash": recipe["resume"]["policyHash"],
        "referenceHash": recipe["resume"]["referenceHash"],
        "valueModelHash": recipe["resume"]["valueModelHash"],
        "optimizerStateHash": recipe["resume"]["optimizerStateHash"],
    }, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def restore_checkpoint(
    checkpoint_path: str | None,
    recipe: dict[str, Any],
    policy: torch.nn.Module,
    value_head: torch.nn.Module,
    policy_optimizer: torch.optim.Optimizer,
    value_optimizer: torch.optim.Optimizer,
) -> int:
    if not checkpoint_path:
        if recipe["resume"]["checkpointId"] is not None:
            raise ContractError("PPO resume requested a checkpoint but no verified path was supplied.")
        return 0
    directory = Path(checkpoint_path).resolve()
    if directory.is_file():
        directory = directory.parent
    manifest = json.loads((directory / "checkpoint.json").read_text(encoding="utf-8"))
    for key in ("policyHash", "referenceHash", "valueModelHash", "optimizerStateHash"):
        if manifest.get(key) != recipe["resume"].get(key):
            raise ContractError(f"PPO checkpoint {key} does not match the recipe.")
    adapter_state = load_file(str(directory / "adapter" / "adapter_model.safetensors"))
    policy.load_state_dict(adapter_state, strict=False)
    value_head.load_state_dict(load_file(str(directory / "value_head.safetensors")))
    optimizer_state = torch.load(
        directory / "optimizer.pt",
        map_location="cpu",
        weights_only=True,
    )
    policy_optimizer.load_state_dict(optimizer_state["policy"])
    value_optimizer.load_state_dict(optimizer_state["value"])
    return int(manifest["step"])


def expected_output_text(task: dict[str, Any]) -> str:
    expected = task.get("expectedOutput")
    if isinstance(expected, dict) and isinstance(expected.get("text"), str):
        return expected["text"]
    if expected is None:
        raise ContractError(f"PPO verifier task {task.get('id')} has no expected output.")
    return json.dumps(expected, sort_keys=True, ensure_ascii=False)


def explained_variance(returns: list[float], values: list[float]) -> float | None:
    if len(returns) < 2:
        return None
    return_tensor = torch.tensor(returns)
    variance = torch.var(return_tensor, unbiased=False)
    if float(variance.item()) == 0:
        return None
    residual = return_tensor - torch.tensor(values)
    return float((1 - torch.var(residual, unbiased=False) / variance).item())


def normalize(values: list[float]) -> list[float]:
    tensor = torch.tensor(values)
    if len(values) == 1:
        return [float(tensor.item())]
    standard_deviation = torch.std(tensor, unbiased=False)
    if float(standard_deviation.item()) < 1e-8:
        return [0.0 for _ in values]
    normalized = (tensor - torch.mean(tensor)) / (standard_deviation + 1e-8)
    return [float(item) for item in normalized]


def ensure_active(cancelled: Callable[[], bool], deadline: float) -> None:
    if cancelled():
        from .worker import Cancelled
        raise Cancelled("PPO training was cancelled.")
    if time.monotonic() >= deadline:
        raise RuntimeError("PPO worker exceeded its declared wall-time limit.")


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.write_text(
        "".join(json.dumps(row, sort_keys=True) + "\n" for row in rows),
        encoding="utf-8",
    )


def utc_now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
