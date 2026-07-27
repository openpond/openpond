from __future__ import annotations

from dataclasses import dataclass
from typing import Any


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
