#!/usr/bin/env python3
"""Bounded JSONL bridge for the public tau3 Retail environment.

The OpenPond adapter owns policy inference. This process owns only the pinned
Retail database, tools, state transitions, and deterministic end-state grade.
"""

from __future__ import annotations

import json
import subprocess
import sys
from typing import Any

from tau2.data_model.message import ToolCall
from tau2.registry import registry


def emit(value: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(value, default=str, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def task_by_id(task_id: str):
    for task in registry.get_tasks_loader("retail")(None):
        if task.id == task_id:
            return task
    raise ValueError(f"tau3_retail_task_missing:{task_id}")


def initialize_environment(environment, task) -> None:
    initial = task.initial_state
    environment.set_state(
        initialization_data=(initial.initialization_data if initial else None),
        initialization_actions=(initial.initialization_actions if initial else None),
        message_history=list(initial.message_history or []) if initial else [],
    )


def visible_user_prompt(task) -> str:
    scenario = task.user_scenario
    instructions = scenario.instructions
    if isinstance(instructions, str):
        return instructions
    parts = [instructions.reason_for_call]
    if instructions.known_info:
        parts.append(instructions.known_info)
    return "\n\n".join(part.strip() for part in parts if part and part.strip())


def tool_contract(tool) -> dict[str, Any]:
    serialized = tool.model_dump(mode="json")
    return {
        "type": "function",
        "function": {
            "name": tool.name,
            "description": tool.short_desc,
            "parameters": serialized["params"],
            "strict": True,
        },
    }


def parse_arguments(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        raise ValueError("tau3_tool_arguments_invalid")
    parsed = json.loads(value)
    if not isinstance(parsed, dict):
        raise ValueError("tau3_tool_arguments_invalid")
    return parsed


def main() -> None:
    if len(sys.argv) != 2:
        raise ValueError("tau3_retail_task_id_missing")
    task = task_by_id(sys.argv[1])
    environment_factory = registry.get_env_constructor("retail")
    environment = environment_factory()
    initialize_environment(environment, task)
    gold = environment_factory()
    initialize_environment(gold, task)
    for action in task.evaluation_criteria.actions or []:
        try:
            gold.make_tool_call(
                tool_name=action.name,
                requestor=action.requestor,
                **action.arguments,
            )
        except Exception:
            # Upstream τ3 criteria include read-only evidence calls whose
            # recorded product can be absent from the pinned database. The
            # official environment evaluator treats those as non-mutating
            # replay evidence and continues building the golden end state.
            continue

    source_commit = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    expected_actions = list(task.evaluation_criteria.actions or [])
    successful_calls: list[dict[str, Any]] = []
    attempted_call_count = 0
    failed_call_count = 0
    premature_mutation = False
    unexpected_mutation = False
    confirmation_turns = 0
    terminal = False
    resolved_communication = False

    for raw_line in sys.stdin:
        request = json.loads(raw_line)
        operation = request.get("operation")
        if operation == "init":
            emit(
                {
                    "sourceCommit": source_commit,
                    "policy": environment.get_policy(),
                    "userPrompt": visible_user_prompt(task),
                    "tools": [tool_contract(tool) for tool in environment.get_tools()],
                }
            )
            continue
        if operation != "step":
            raise ValueError("tau3_bridge_operation_unsupported")

        tool_results: list[dict[str, Any]] = []
        successful_mutation = False
        calls = request.get("toolCalls") or []
        content = request.get("content")
        resolved_communication = bool(isinstance(content, str) and content.strip())
        for index, call in enumerate(calls):
            attempted_call_count += 1
            call_id = str(call.get("id") or f"tool_call_{index + 1}")
            name = str(call.get("name") or "")
            try:
                arguments = parse_arguments(call.get("arguments", {}))
                mutates = environment._is_mutating_tool(name)
                output = environment.make_tool_call(tool_name=name, **arguments)
                successful_mutation = successful_mutation or mutates
                tool_call = ToolCall(
                    id=call_id,
                    name=name,
                    arguments=arguments,
                    requestor="assistant",
                )
                matching_actions = [
                    action for action in expected_actions
                    if action.requestor == "assistant" and action.compare_with_tool_call(tool_call)
                ]
                if mutates and not matching_actions:
                    unexpected_mutation = True
                tool = next((candidate for candidate in environment.get_tools() if candidate.name == name), None)
                requires_confirmation = bool(
                    tool is not None
                    and "explicit user confirmation" in tool.short_desc.lower()
                )
                if mutates and requires_confirmation and confirmation_turns == 0:
                    premature_mutation = True
                successful_calls.append(
                    {"call": tool_call, "mutates": mutates}
                )
                tool_results.append({"id": call_id, "name": name, "output": output})
            except Exception as error:  # Tool errors are policy evidence, not bridge failure.
                failed_call_count += 1
                tool_results.append(
                    {
                        "id": call_id,
                        "name": name,
                        "output": {"error": type(error).__name__, "message": str(error)[:1000]},
                    }
                )

        user_message = None
        if successful_mutation:
            terminal = True
        elif not calls:
            if confirmation_turns == 0:
                confirmation_turns += 1
                user_message = "Yes, I confirm. Please proceed with the request I described."
            else:
                terminal = True

        db_reward = float(
            environment.get_db_hash() == gold.get_db_hash()
            and environment.get_user_db_hash() == gold.get_user_db_hash()
        )
        matched_indexes: set[int] = set()
        matched_writes = 0
        matched_reads = 0
        expected_writes = 0
        expected_reads = 0
        for action in expected_actions:
            if action.requestor != "assistant":
                continue
            action_mutates = environment._is_mutating_tool(action.name)
            if action_mutates:
                expected_writes += 1
            else:
                expected_reads += 1
            for call_index, successful in enumerate(successful_calls):
                if call_index in matched_indexes:
                    continue
                if action.compare_with_tool_call(successful["call"]):
                    matched_indexes.add(call_index)
                    if action_mutates:
                        matched_writes += 1
                    else:
                        matched_reads += 1
                    break
        tool_validity = (
            (attempted_call_count - failed_call_count) / attempted_call_count
            if attempted_call_count else 0.0
        )
        invalid_tool_rate = failed_call_count / attempted_call_count if attempted_call_count else 0.0
        required_write_coverage = matched_writes / expected_writes if expected_writes else 1.0
        required_read_coverage = matched_reads / expected_reads if expected_reads else 1.0
        action_valid = float(failed_call_count == 0)
        reward = db_reward * action_valid if terminal else 0.0
        emit(
            {
                "toolResults": tool_results,
                "userMessage": user_message,
                "terminal": terminal,
                "reward": reward,
                "components": {
                    "terminalState": db_reward,
                    "toolExecution": action_valid,
                    "requiredWriteCoverage": required_write_coverage,
                    "requiredReadCoverage": required_read_coverage,
                    "toolValidity": tool_validity,
                    "resolvedCommunication": float(resolved_communication),
                    "prematureMutation": float(premature_mutation),
                    "unexpectedMutation": float(unexpected_mutation),
                    "invalidToolRate": invalid_tool_rate,
                },
                "stateHashes": {
                    "predicted": environment.get_db_hash(),
                    "expected": gold.get_db_hash(),
                },
            }
        )


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit({"fatal": type(error).__name__, "message": str(error)[:2000]})
        raise
