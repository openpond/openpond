"""Canonical JSON compatible with @openpond/taskset-sdk.

Python and JavaScript choose different spellings for some finite numbers
(for example ``5e-05`` versus ``0.00005``). Content-addressed contracts cross
the TypeScript/Python boundary, so their serializer must use the JavaScript
``JSON.stringify`` number thresholds rather than Python's default encoder.
"""

from __future__ import annotations

import hashlib
import json
import math
from decimal import Decimal
from typing import Any


def canonical_json(value: Any) -> str:
    return _encode(value, 0) + "\n"


def content_hash(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def _encode(value: Any, depth: int) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return _javascript_number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (list, tuple)):
        if not value:
            return "[]"
        indentation = "  " * (depth + 1)
        return (
            "[\n"
            + ",\n".join(
                indentation + _encode(item, depth + 1)
                for item in value
            )
            + "\n"
            + "  " * depth
            + "]"
        )
    if isinstance(value, dict):
        if not value:
            return "{}"
        indentation = "  " * (depth + 1)
        members = []
        for key in sorted(value, key=lambda item: (item.casefold(), item)):
            if not isinstance(key, str):
                raise TypeError("Canonical JSON object keys must be strings.")
            members.append(
                indentation
                + json.dumps(key, ensure_ascii=False)
                + ": "
                + _encode(value[key], depth + 1)
            )
        return (
            "{\n"
            + ",\n".join(members)
            + "\n"
            + "  " * depth
            + "}"
        )
    raise TypeError(
        f"Unsupported canonical JSON value: {type(value).__name__}"
    )


def _javascript_number(value: float) -> str:
    if not math.isfinite(value):
        raise ValueError("Canonical JSON numbers must be finite.")
    if value == 0:
        return "0"
    decimal = Decimal(repr(value))
    adjusted = decimal.adjusted()
    if -6 <= adjusted < 21:
        fixed = format(decimal, "f")
        if "." in fixed:
            fixed = fixed.rstrip("0").rstrip(".")
        return fixed
    mantissa, exponent_text = repr(value).lower().split("e")
    mantissa = mantissa.rstrip("0").rstrip(".")
    exponent = int(exponent_text)
    sign = "+" if exponent >= 0 else ""
    return f"{mantissa}e{sign}{exponent}"
