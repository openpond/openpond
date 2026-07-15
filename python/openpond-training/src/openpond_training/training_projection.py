from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .contracts import ContractError
from .inference import normalized_messages
from .model_runtime import input_text, output_text, render_training_record


@dataclass(frozen=True)
class TrainingProjection:
    rows: list[dict[str, Any]]
    completion_only: bool
    assistant_target_count: int
    context_truncated_example_count: int
    context_tokens_dropped: int

    @property
    def sample_input_ids(self) -> list[int] | None:
        first = self.rows[0] if self.rows else None
        value = first.get("input_ids") if first else None
        return list(value) if isinstance(value, list) else None


def build_training_projection(
    records: list[dict[str, Any]],
    tokenizer,
    *,
    completion_only: bool,
    max_length: int,
) -> TrainingProjection:  # type: ignore[no-untyped-def]
    if not completion_only:
        rows = [{"text": render_training_record(record, tokenizer)} for record in records]
        if not rows:
            raise ContractError("Training bundle contains no records.")
        return TrainingProjection(
            rows=rows,
            completion_only=False,
            assistant_target_count=0,
            context_truncated_example_count=0,
            context_tokens_dropped=0,
        )

    rows: list[dict[str, Any]] = []
    truncated_examples = 0
    tokens_dropped = 0
    for record in records:
        messages = training_messages(record)
        for index, message in enumerate(messages):
            if message["role"] != "assistant":
                continue
            row, dropped = tokenize_completion(
                tokenizer,
                prompt=messages[:index],
                completion=[message],
                max_length=max_length,
            )
            rows.append(row)
            if dropped:
                truncated_examples += 1
                tokens_dropped += dropped
    if not rows:
        raise ContractError("Completion-only training requires at least one assistant target.")
    return TrainingProjection(
        rows=rows,
        completion_only=True,
        assistant_target_count=len(rows),
        context_truncated_example_count=truncated_examples,
        context_tokens_dropped=tokens_dropped,
    )


def training_messages(record: dict[str, Any]) -> list[dict[str, str]]:
    input_value = record.get("input")
    expected_value = record.get("expectedOutput")
    candidates: list[Any] = []
    if isinstance(input_value, dict) and isinstance(input_value.get("messages"), list):
        candidates.extend(input_value["messages"])
    if isinstance(expected_value, dict) and isinstance(expected_value.get("messages"), list):
        candidates.extend(expected_value["messages"])
    if candidates:
        return normalized_messages(candidates)
    prompt = input_text(input_value if isinstance(input_value, dict) else input_value or {})
    expected = output_text(expected_value if isinstance(expected_value, dict) else expected_value or {})
    return [
        {"role": "user", "content": prompt},
        {"role": "assistant", "content": expected},
    ]


def tokenize_completion(
    tokenizer,
    *,
    prompt: list[dict[str, str]],
    completion: list[dict[str, str]],
    max_length: int,
) -> tuple[dict[str, list[int]], int]:  # type: ignore[no-untyped-def]
    if not prompt or not any(message["role"] == "user" for message in prompt):
        raise ContractError("Completion-only training target has no preceding user message.")
    prompt_ids = list(tokenizer.apply_chat_template(prompt, tokenize=True, add_generation_prompt=True))
    full_ids = list(tokenizer.apply_chat_template(prompt + completion, tokenize=True, add_generation_prompt=False))
    if full_ids[: len(prompt_ids)] != prompt_ids:
        raise ContractError("Tokenizer chat template does not preserve the prompt prefix for completion-only training.")
    completion_ids = full_ids[len(prompt_ids):]
    if not completion_ids:
        raise ContractError("Completion-only training produced an empty assistant target.")
    if len(completion_ids) > max_length:
        raise ContractError(
            f"Assistant target requires {len(completion_ids)} tokens and cannot fit the {max_length}-token sequence length."
        )
    dropped = max(0, len(full_ids) - max_length)
    kept_ids = full_ids[dropped:]
    kept_prompt_tokens = max(0, len(prompt_ids) - dropped)
    completion_mask = [0] * kept_prompt_tokens + [1] * len(completion_ids)
    if len(kept_ids) != len(completion_mask) or not any(completion_mask):
        raise ContractError("Completion-only projection failed to preserve the assistant target mask.")
    return {
        "input_ids": kept_ids,
        "attention_mask": [1] * len(kept_ids),
        "completion_mask": completion_mask,
    }, dropped
