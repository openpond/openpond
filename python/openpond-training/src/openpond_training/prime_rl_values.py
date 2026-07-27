from __future__ import annotations

import math
from typing import Any

from .canonical_json import content_hash
from .prime_rl_contracts import PrimeRlExecutionError


def validate_hashed_object(
    value: dict[str, Any], error_code: str
) -> None:
    supplied = value.get("contentHash")
    content = {
        key: item for key, item in value.items() if key != "contentHash"
    }
    if not isinstance(supplied, str) or supplied != content_hash(content):
        raise PrimeRlExecutionError(error_code)


def mapping(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise PrimeRlExecutionError(
            f"prime_rl_{label.lower().replace(' ', '_')}_invalid"
        )
    return value


def string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise PrimeRlExecutionError(
            f"prime_rl_{label.lower().replace(' ', '_')}_invalid"
        )
    return value


def positive_int(value: Any, label: str) -> int:
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or value <= 0
    ):
        raise PrimeRlExecutionError(
            f"prime_rl_{label.lower().replace(' ', '_')}_invalid"
        )
    return value


def positive_float(value: Any, label: str) -> float:
    result = finite_float(value, label)
    if result <= 0:
        raise PrimeRlExecutionError(
            f"prime_rl_{label.lower().replace(' ', '_')}_invalid"
        )
    return result


def nonnegative_float(value: Any, label: str) -> float:
    result = finite_float(value, label)
    if result < 0:
        raise PrimeRlExecutionError(
            f"prime_rl_{label.lower().replace(' ', '_')}_invalid"
        )
    return result


def finite_float(value: Any, label: str) -> float:
    if (
        not isinstance(value, (int, float))
        or isinstance(value, bool)
        or not math.isfinite(float(value))
    ):
        raise PrimeRlExecutionError(
            f"prime_rl_{label.lower().replace(' ', '_')}_invalid"
        )
    return float(value)


def worker_digest(value: Any) -> bool:
    return (
        isinstance(value, str)
        and value.startswith("sha256:")
        and len(value) == 71
        and all(character in "0123456789abcdef" for character in value[7:])
    )
