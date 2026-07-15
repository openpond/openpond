import pytest
import torch

from openpond_training.contracts import ContractError
from openpond_training.fixture_model import render_record
from openpond_training.inference import (
    fixture_protocol_completion,
    left_truncate_encoded_input,
    normalized_messages,
    request_context_window_tokens,
)


def test_normalized_messages_keeps_supported_chat_history() -> None:
    assert normalized_messages([
        {"role": "system", "content": "Be concise."},
        {"role": "user", "content": "Hello"},
        {"role": "assistant", "content": "Hi"},
        {"role": "assistant", "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "search_crm", "arguments": "{\"query\":\"Atlas\"}"}}]},
        {"role": "tool", "tool_call_id": "call_1", "content": "{\"items\":[]}"},
    ]) == [
        {"role": "system", "content": "Be concise."},
        {"role": "user", "content": "Hello"},
        {"role": "assistant", "content": "Hi"},
        {"role": "assistant", "content": '{"type":"tool_call","name":"search_crm","arguments":{"query":"Atlas"}}'},
        {"role": "user", "content": '{"type":"tool_result","name":"search_crm","ok":true,"result":{"items":[]},"error":null}'},
    ]


def test_normalized_messages_requires_user_input() -> None:
    with pytest.raises(ContractError, match="at least one user message"):
        normalized_messages([{"role": "system", "content": "No user"}])


def test_fixture_protocol_runs_one_native_tool_turn_then_returns_text() -> None:
    initial = [
        {"role": "system", "content": "LOCAL TOOL PROTOCOL: emit one JSON call."},
        {"role": "user", "content": "Find the renewal exposure."},
    ]
    assert '"name":"search_crm"' in fixture_protocol_completion(initial)
    after_tool = [
        *initial,
        {"role": "user", "content": '{"type":"tool_result","name":"search_crm","ok":true,"result":{},"error":null}'},
    ]
    assert fixture_protocol_completion(after_tool) == "ANSWER: {}"


def test_fixture_vocabulary_includes_structured_tool_trajectory_messages() -> None:
    rendered = render_record({
        "input": {"prompt": "Find Atlas", "messages": [
            {"role": "system", "content": "Use tools."},
            {"role": "user", "content": "Find Atlas"},
        ]},
        "expectedOutput": {"text": "ANSWER: {}", "messages": [
            {"role": "assistant", "content": None, "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "search_crm", "arguments": "{\"query\":\"Atlas\"}"}}]},
            {"role": "tool", "tool_call_id": "call_1", "content": "{\"items\":[]}"},
            {"role": "assistant", "content": "ANSWER: {}"},
        ]},
    })
    assert '"type":"tool_call"' in rendered
    assert '"type":"tool_result"' in rendered


def test_inference_context_window_is_required_and_bounded() -> None:
    assert request_context_window_tokens({"contextWindowTokens": 1024}) == 1024
    for value in [None, True, 127, 32_769, 1024.0]:
        with pytest.raises(ContractError, match="contextWindowTokens"):
            request_context_window_tokens({"contextWindowTokens": value})


def test_inference_left_truncates_every_token_aligned_tensor() -> None:
    encoded = {
        "input_ids": torch.arange(12).reshape(1, 12),
        "attention_mask": torch.ones((1, 12), dtype=torch.long),
        "unrelated": torch.ones((1, 3), dtype=torch.long),
    }
    assert left_truncate_encoded_input(encoded, 5) == (12, 7)
    assert encoded["input_ids"].tolist() == [[7, 8, 9, 10, 11]]
    assert encoded["attention_mask"].shape[-1] == 5
    assert encoded["unrelated"].shape[-1] == 3
