from __future__ import annotations

import json
from pathlib import Path

from .engine_adapters import PRIME_RL_UPSTREAM_REVISION
from .prime_rl_contracts import PrimeRlSettings


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
            (
                "# requested_checkpoint_interval = "
                f"{settings.checkpoint_every_steps}"
            ),
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
        "[renderer]",
        'name = "default"',
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


def toml_string(value: str) -> str:
    return json.dumps(value)
