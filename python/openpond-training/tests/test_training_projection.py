from __future__ import annotations

import json

import pytest

from openpond_training.contracts import ContractError
from openpond_training.fixture_model import construct_fixture
from openpond_training.training_projection import build_training_projection, training_messages


def structured_record() -> dict:
    return {
        "input": {"messages": [
            {"role": "system", "content": "Use the registered tools."},
            {"role": "user", "content": "Find Atlas."},
        ]},
        "expectedOutput": {"messages": [
            {"role": "assistant", "content": None, "tool_calls": [{
                "id": "call_1",
                "type": "function",
                "function": {"name": "search_crm", "arguments": "{\"query\":\"Atlas\"}"},
            }]},
            {"role": "tool", "tool_call_id": "call_1", "content": " ".join(["result"] * 80)},
            {"role": "assistant", "content": "ANSWER: {\"account_id\":\"acct_1\"}"},
        ]},
    }


def test_completion_only_expands_assistant_turns_and_preserves_every_target() -> None:
    record = structured_record()
    _model, tokenizer, _hash = construct_fixture([record], seed=17)
    projection = build_training_projection([record], tokenizer, completion_only=True, max_length=40)

    assert projection.assistant_target_count == 2
    assert len(projection.rows) == 2
    assert projection.context_truncated_example_count == 1
    assert projection.context_tokens_dropped > 0
    for row in projection.rows:
        assert len(row["input_ids"]) <= 40
        assert len(row["input_ids"]) == len(row["completion_mask"])
        assert row["completion_mask"][-1] == 1
        assert sum(row["completion_mask"]) > 0


def test_completion_only_rejects_a_target_larger_than_the_sequence() -> None:
    record = structured_record()
    _model, tokenizer, _hash = construct_fixture([record], seed=17)
    with pytest.raises(ContractError, match="Assistant target requires"):
        build_training_projection([record], tokenizer, completion_only=True, max_length=3)


def test_full_sequence_projection_keeps_language_modeling_records() -> None:
    record = {"input": {"prompt": "Say hello"}, "expectedOutput": {"text": "Hello friend"}}
    _model, tokenizer, _hash = construct_fixture([record], seed=17)
    projection = build_training_projection([record], tokenizer, completion_only=False, max_length=64)

    assert projection.completion_only is False
    assert projection.assistant_target_count == 0
    assert list(projection.rows[0]) == ["text"]


def test_structured_projection_canonicalizes_provider_call_ids_and_runtime_json() -> None:
    record = structured_record()
    record["expectedOutput"]["messages"][0]["tool_calls"][0]["id"] = "provider_generated_identifier_that_should_not_be_learned"
    record["expectedOutput"]["messages"][1]["tool_call_id"] = "provider_generated_identifier_that_should_not_be_learned"
    messages = training_messages(record)
    first_target = next(message["content"] for message in messages if message["role"] == "assistant")
    tool_result = next(message["content"] for message in messages if message["role"] == "user" and "tool_result" in message["content"])

    assert "provider_generated_identifier" not in first_target
    assert "call_1" not in first_target
    assert '"type":"tool_call"' in first_target
    assert "provider_generated_identifier" not in tool_result
    assert "call_1" not in tool_result
    assert json.loads(tool_result) == {
        "type": "tool_result",
        "name": "search_crm",
        "ok": True,
        "result": " ".join(["result"] * 80),
        "error": None,
    }
