import pytest

from openpond_training.contracts import ContractError
from openpond_training.fixture_model import render_record
from openpond_training.inference import fixture_protocol_completion, normalized_messages


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
        {"role": "assistant", "content": '{"arguments": {"query": "Atlas"}, "id": "call_1", "name": "search_crm", "type": "tool_call"}'},
        {"role": "user", "content": '{"content": "{\\"items\\":[]}", "tool_call_id": "call_1", "type": "tool_result"}'},
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
        {"role": "user", "content": '{"type":"tool_result","tool_call_id":"fixture_search_crm_1","content":"{}"}'},
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
    assert '"type": "tool_call"' in rendered
    assert '"type": "tool_result"' in rendered
