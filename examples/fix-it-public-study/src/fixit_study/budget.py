"""Durable call reservations, token accounting and no replay after uncertainty.

Reserve the documented model's entire context window plus the bounded output
before each request. This deliberately avoids relying on a tokenizer estimate
for a financial boundary. Unused capacity is released only with actual usage.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from decimal import Decimal
from importlib.resources import files
from pathlib import Path

CALL_CONTEXT: ContextVar[dict] = ContextVar("fixit_study_call", default={})
NANO_USD = 1_000_000_000
PRICING = json.loads(files("fixit_study").joinpath("pricing.json").read_bytes())


class BudgetStop(RuntimeError):
    """No further paid requests are authorized by this retained ledger."""


def nano_usd(value: str) -> int:
    amount = Decimal(value)
    units = amount * NANO_USD
    if not amount.is_finite() or amount <= 0 or units != units.to_integral_value():
        raise ValueError("Choose a positive USD limit with at most nine decimal places")
    return int(units)


def model_rate(model: str) -> tuple[str, dict]:
    name = model.removeprefix("openai/").removeprefix("responses/")
    for snapshot, rate in PRICING["models"].items():
        if name == snapshot or name in rate["aliases"]:
            return snapshot, rate
    raise BudgetStop("The request model has no frozen price or context bound")


def reservation_units(rate: dict, output_tokens: int) -> int:
    return int(rate["contextTokens"] * rate["inputNanoUsdPerToken"] * rate["longInputMultiplier"]
               + output_tokens * rate["outputNanoUsdPerToken"] * rate["longOutputMultiplier"])


class CallBudget:
    def __init__(self, path: Path, maximum_usd: str):
        self.maximum = nano_usd(maximum_usd)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), maximum INTEGER NOT NULL)")
        self.db.execute("CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, model TEXT NOT NULL, context TEXT NOT NULL, request_hash TEXT NOT NULL, state TEXT NOT NULL, reserved INTEGER NOT NULL, actual INTEGER, usage TEXT, created REAL NOT NULL, finished REAL)")
        prior = self.db.execute("SELECT maximum FROM settings WHERE id=1").fetchone()
        if prior is None:
            self.db.execute("INSERT INTO settings VALUES (1,?)", (self.maximum,))
        elif prior["maximum"] != self.maximum:
            raise BudgetStop("A retained run's spending limit cannot be changed")
        # The run holds an OS file lock; these are interrupted earlier requests.
        self.db.execute("UPDATE calls SET state='unknown' WHERE state='reserved'")

    def close(self) -> None:
        self.db.close()

    def has_uncertain(self) -> bool:
        with self.lock:
            return self.db.execute("SELECT 1 FROM calls WHERE state IN ('reserved','unknown','violation') LIMIT 1").fetchone() is not None

    def summary(self) -> dict:
        rows = [dict(row) for row in self.db.execute("SELECT * FROM calls ORDER BY created,id")]
        actual = sum(row["actual"] or 0 for row in rows)
        held = sum(row["reserved"] for row in rows if row["state"] in ("unknown", "reserved"))
        return {"maximumUsd": str(Decimal(self.maximum) / NANO_USD),
                "actualUsd": str(Decimal(actual) / NANO_USD),
                "unresolvedHeldUsd": str(Decimal(held) / NANO_USD),
                "requestCount": len(rows), "calls": rows}

    def reserve(self, model: str, rate: dict, output_tokens: int, request: dict) -> str:
        reserve = reservation_units(rate, output_tokens)
        call_id = str(uuid.uuid4())
        fingerprint = hashlib.sha256(json.dumps(request, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                unresolved = self.db.execute("SELECT 1 FROM calls WHERE state IN ('unknown','violation') LIMIT 1").fetchone()
                spent = self.db.execute("SELECT coalesce(sum(CASE WHEN state='settled' THEN actual ELSE reserved END),0) FROM calls").fetchone()[0]
                if unresolved or spent + reserve > self.maximum:
                    raise BudgetStop("The spending limit or an uncertain earlier request blocks new inference")
                self.db.execute("INSERT INTO calls VALUES (?,?,?,?,?,?,NULL,NULL,?,NULL)",
                                (call_id, model, json.dumps(CALL_CONTEXT.get(), sort_keys=True), fingerprint, "reserved", reserve, time.time()))
                self.db.execute("COMMIT")
            except BaseException:
                self.db.execute("ROLLBACK")
                raise
        return call_id

    def unknown(self, call_id: str) -> None:
        with self.lock:
            self.db.execute("UPDATE calls SET state='unknown',finished=? WHERE id=? AND state='reserved'", (time.time(), call_id))

    def settle(self, call_id: str, rate: dict, response, output_tokens: int) -> None:
        usage = response.usage
        if usage is None:
            self.unknown(call_id)
            raise BudgetStop("Missing actual usage; reservation retained and further inference blocked")
        prompt, completion = usage.prompt_tokens, usage.completion_tokens
        details = usage.prompt_tokens_details
        cached = (details.cached_tokens or 0) if details is not None else 0
        values = (prompt, completion, cached)
        if any(type(value) is not int or value < 0 for value in values) or cached > prompt:
            self.unknown(call_id)
            raise BudgetStop("Invalid provider usage; reservation retained")
        long = rate["longContextThreshold"] is not None and prompt > rate["longContextThreshold"]
        input_multiplier = rate["longInputMultiplier"] if long else 1
        output_multiplier = rate["longOutputMultiplier"] if long else 1
        actual = int(((prompt-cached)*rate["inputNanoUsdPerToken"] + cached*rate["cachedInputNanoUsdPerToken"]) * input_multiplier
                     + completion*rate["outputNanoUsdPerToken"]*output_multiplier)
        with self.lock:
            reserved = self.db.execute("SELECT reserved FROM calls WHERE id=? AND state='reserved'", (call_id,)).fetchone()
            if reserved is None:
                raise BudgetStop("The call reservation changed before settlement")
            violation = prompt > rate["contextTokens"] or completion > output_tokens or actual > reserved["reserved"]
            self.db.execute("UPDATE calls SET state=?,actual=?,usage=?,finished=? WHERE id=?", (
                "violation" if violation else "settled", actual,
                json.dumps({"inputTokens": prompt, "outputTokens": completion, "cachedInputTokens": cached,
                            "responseModel": response.model, "responseId": response.id}), time.time(), call_id))
        if violation:
            raise BudgetStop("Provider usage exceeded the declared bound; further inference blocked")


@contextmanager
def meter_tau2(budget: CallBudget, output_tokens: int):
    """Instrument the pinned text caller, simulator and official judge boundary."""
    import litellm
    from tau2.utils import llm_utils

    original_completion, original_generate = llm_utils.completion, llm_utils._generate_once
    litellm.disable_cache()

    def generate(*args, **kwargs):
        token = CALL_CONTEXT.set({**CALL_CONTEXT.get(), "purpose": kwargs.get("call_name") or "unspecified"})
        try:
            return original_generate(*args, **kwargs)
        finally:
            CALL_CONTEXT.reset(token)

    def completion(*args, **kwargs):
        if args or kwargs.get("stream") or kwargs.get("n", 1) != 1:
            raise BudgetStop("This protocol permits one non-streaming completion per request")
        snapshot, rate = model_rate(kwargs["model"])
        kwargs["model"] = f"openai/responses/{snapshot}"
        kwargs.pop("max_tokens", None)
        kwargs["max_completion_tokens"] = output_tokens
        kwargs.update(num_retries=0, max_retries=0, timeout=120, caching=False,
                      api_base="https://api.openai.com/v1", service_tier="default")
        allowed = list(kwargs.get("allowed_openai_params") or [])
        kwargs["allowed_openai_params"] = list(dict.fromkeys([*allowed, "max_completion_tokens", "service_tier"]))
        request = {key: value for key, value in kwargs.items() if key not in ("api_key", "headers", "extra_headers")}
        call_id = budget.reserve(snapshot, rate, output_tokens, request)
        try:
            response = original_completion(**kwargs)
        except BaseException:
            budget.unknown(call_id)
            # Do not echo upstream errors which can contain headers or credentials.
            raise BudgetStop("Model request failed; its outcome is uncertain and its reservation remains held") from None
        try:
            budget.settle(call_id, rate, response, output_tokens)
        except BaseException:
            budget.unknown(call_id)
            raise
        return response

    llm_utils.completion, llm_utils._generate_once = completion, generate
    try:
        yield
    finally:
        llm_utils.completion, llm_utils._generate_once = original_completion, original_generate
