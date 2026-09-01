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
    action_valid = 1.0
    confirmation_turns = 0
    terminal = False

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
        for index, call in enumerate(calls):
            call_id = str(call.get("id") or f"tool_call_{index + 1}")
            name = str(call.get("name") or "")
            try:
                arguments = parse_arguments(call.get("arguments", {}))
                mutates = environment._is_mutating_tool(name)
                output = environment.make_tool_call(tool_name=name, **arguments)
                successful_mutation = successful_mutation or mutates
                tool_results.append({"id": call_id, "name": name, "output": output})
            except Exception as error:  # Tool errors are policy evidence, not bridge failure.
                action_valid = 0.0
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
