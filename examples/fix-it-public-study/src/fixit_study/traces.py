"""Observe real upstream tool calls without changing arguments or results."""

from __future__ import annotations

import hashlib
import json
import os
import time
from collections import defaultdict, deque
from pathlib import Path


def digest(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


class ToolTrace:
    def __init__(self, path: Path, identity: dict):
        self.path, self.identity = path, identity
        self.records: list[dict] = []
        self.previous = "0" * 64
        self.initial = None
        self.unmatched = 0

    def append(self, value: dict) -> dict:
        record = {"sequence": len(self.records), "observedAt": time.time(),
                  "previousSha256": self.previous, **self.identity, **value}
        record["sha256"] = digest(record)
        raw = json.dumps(record, ensure_ascii=False) + "\n"
        if len(raw.encode()) > 16 * 1024 * 1024:
            raise RuntimeError("Tool evidence exceeds the frozen per-record limit")
        with self.path.open("a", encoding="utf-8") as output:
            output.write(raw)
            output.flush()
            os.fsync(output.fileno())
        self.records.append(record)
        self.previous = record["sha256"]
        return record

    def attach(self, orchestrator) -> None:
        initialize = orchestrator._initialize_environment
        execute = orchestrator._execute_tool_calls

        def initialize_observed(*args, **kwargs):
            initialize(*args, **kwargs)
            self.initial = {"agentDatabaseHash": orchestrator.environment.get_db_hash(),
                            "userDatabaseHash": orchestrator.environment.get_user_db_hash()}
            self.append({"kind": "initialized", **self.initial})

        def execute_observed(tool_calls):
            pending = defaultdict(deque)
            for call in tool_calls:
                payload = call.model_dump(mode="json")
                attempt = self.append({"kind": "attempt", "call": payload})
                pending[call.id].append(attempt)
            results = execute(tool_calls)
            for result in results:
                attempt = pending[result.id].popleft() if pending[result.id] else None
                if attempt is None:
                    self.unmatched += 1
                self.append({"kind": "observation", "attemptSha256": attempt["sha256"] if attempt else None,
                             "result": result.model_dump(mode="json")})
            return results

        orchestrator._initialize_environment = initialize_observed
        orchestrator._execute_tool_calls = execute_observed

    def summary(self) -> dict:
        observations = [record for record in self.records if record["kind"] == "observation"
                        and record["result"]["requestor"] == "assistant"]
        failures = [record for record in observations if record["result"]["error"]]
        return {"toolCallsObserved": len(observations), "eligibleFailures": len(failures),
                "unmatchedResults": self.unmatched, "traceSha256": self.previous,
                "initialState": self.initial, "mapping": "typed ToolMessage.error; no text heuristics"}

    def review_candidates(self) -> list[dict]:
        if self.identity["split"] != "correction_source":
            raise ValueError("Only the declared training-source partition may produce correction candidates")
        attempts = {record["sha256"]: record for record in self.records if record["kind"] == "attempt"}
        observations = [record for record in self.records if record["kind"] == "observation"
                        and record["result"]["requestor"] == "assistant" and record["attemptSha256"] in attempts]
        candidates = []
        for index, failure in enumerate(observations):
            if not failure["result"]["error"]:
                continue
            original = attempts[failure["attemptSha256"]]
            # A later same-tool success is only a review lead. It does not prove
            # that the action corrected this failure or that the task succeeded.
            recovery = next((later for later in observations[index+1:]
                             if not later["result"]["error"]
                             and attempts[later["attemptSha256"]]["call"]["name"] == original["call"]["name"]), None)
            candidates.append({**self.identity, "failure": failure, "failedAttempt": original,
                               "possibleRecovery": recovery,
                               "possibleCorrectedAttempt": attempts[recovery["attemptSha256"]] if recovery else None,
                               "attribution": "unverified", "targetApproval": "pending_owner_review",
                               "trainingAuthorized": False})
        return candidates
