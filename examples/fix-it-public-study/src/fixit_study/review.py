"""Export auditable correction-source evidence without approving targets."""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import tempfile
from decimal import Decimal
from contextlib import closing
from pathlib import Path

from filelock import FileLock

from .execute import write_json
from .budget import NANO_USD, nano_usd
from .plan import SOURCE_COMMIT, selected_tasks, verify_upstream
from .traces import ToolTrace, digest

MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_PACKET_BYTES = 1024 * 1024 * 1024
BASE_FIELDS = {"sequence", "observedAt", "previousSha256", "split", "arm", "domain", "taskId", "kind", "sha256"}
EVENT_FIELDS = {
    "initialized": {"agentDatabaseHash", "userDatabaseHash"},
    "agent_visible_context": {"messages", "tools"},
    "attempt": {"call", "agentContextSha256"},
    "observation": {"attemptSha256", "result"},
}


def read_bytes(root: Path, relative: str) -> bytes:
    path = (root / relative).resolve(strict=True)
    if not path.is_relative_to(root) or not path.is_file() or path.stat().st_size > MAX_FILE_BYTES:
        raise ValueError("Evidence must be a bounded file inside the source run")
    with path.open("rb") as source:
        data = source.read(MAX_FILE_BYTES + 1)
    if len(data) > MAX_FILE_BYTES:
        raise ValueError("Source evidence exceeds its file bound")
    return data


def verified_trace(raw: bytes, identity: dict, *, require_complete: bool = True) -> ToolTrace:
    from tau2.data_model.message import ToolCall, ToolMessage

    trace = ToolTrace(Path("unused-read-only-trace"), identity)
    attempts, contexts, observed = {}, {}, set()
    for line in raw.splitlines():
        if len(line) > 16 * 1024 * 1024:
            raise ValueError("Tool record exceeds the producer's bound")
        record = json.loads(line)
        kind = record.get("kind")
        if kind not in EVENT_FIELDS or set(record) != BASE_FIELDS | EVENT_FIELDS[kind]:
            raise ValueError("Unknown trace shape; hidden task/evaluator fields cannot enter review context")
        body = {key: value for key, value in record.items() if key != "sha256"}
        if (record["sequence"] != len(trace.records) or record["previousSha256"] != trace.previous
                or digest(body) != record["sha256"] or any(record[key] != value for key, value in identity.items())):
            raise ValueError("Tool trace identity or hash chain changed")
        if kind == "initialized":
            if trace.records:
                raise ValueError("Initialization must be the first and only initial state")
            trace.initial = {key: record[key] for key in EVENT_FIELDS[kind]}
        elif not trace.initial:
            raise ValueError("Tool evidence has no initial state")
        elif kind == "agent_visible_context":
            contexts[record["sha256"]] = record
        elif kind == "attempt":
            call = record["call"]
            if ToolCall.model_validate(call).model_dump(mode="json") != call:
                raise ValueError("Tool attempt differs from the pinned upstream contract")
            context = record["agentContextSha256"]
            if (call["requestor"] not in ("assistant", "user")
                    or call["requestor"] == "assistant" and context not in contexts
                    or call["requestor"] != "assistant" and context is not None):
                raise ValueError("Attempt has no exact caller-visible context")
            attempts[record["sha256"]] = record
        else:
            reference = record["attemptSha256"]
            attempt = attempts.get(reference)
            result = record["result"]
            if ToolMessage.model_validate(result).model_dump(mode="json") != result:
                raise ValueError("Tool observation differs from the pinned upstream contract")
            if (not attempt or reference in observed or type(result["error"]) is not bool
                    or result["id"] != attempt["call"]["id"]
                    or result["requestor"] != attempt["call"]["requestor"]):
                raise ValueError("Observation does not match one actual tool attempt")
            observed.add(reference)
        trace.records.append(record)
        trace.previous = record["sha256"]
    if not trace.initial or require_complete and set(attempts) != observed:
        raise ValueError("Incomplete tool execution evidence cannot become a review packet")
    return trace


def export_review_packet(run: Path, output: Path) -> dict:
    verify_upstream()
    run, output = run.resolve(strict=True), output.resolve()
    if output.exists() or output == run:
        raise ValueError("Choose a new review-packet directory")
    output.parent.mkdir(parents=True, exist_ok=True)
    with FileLock(run / ".run.lock", timeout=0):
        protocol_raw = read_bytes(run, "protocol.json")
        protocol = json.loads(protocol_raw)
        body = {key: value for key, value in protocol.items() if key != "contentHash"}
        if (protocol.get("schemaVersion") != "openpond.fixitBaselineProtocol.v1"
                or protocol.get("split") != "correction_source" or protocol.get("arm") != "baseline"
                or protocol.get("sourceCommit") != SOURCE_COMMIT or digest(body) != protocol.get("contentHash")):
            raise ValueError("Only the pinned correction-source partition may produce review material")
        _, selected = selected_tasks("correction_source")
        configs = protocol["configs"]
        if (len(configs) != len(selected) or {row["domain"] for row in configs} != set(selected)
                or any(row["language"] != "en" or set(row["task_ids"]) != set(selected[row["domain"]])
                       or len(row["task_ids"]) != len(selected[row["domain"]]) for row in configs)):
            raise ValueError("The protocol differs from the fixed correction-source tasks")
        report_raw = read_bytes(run, "report.json")
        report = json.loads(report_raw)
        if (report.get("schemaVersion") != "openpond.fixitBaselineRun.v1"
                or report.get("protocolHash") != protocol["contentHash"] or report.get("split") != "correction_source"
                or report.get("declaredTaskCount") != 12 or len(report["episodes"]) != 12):
            raise ValueError("A complete source-run accounting record is required")
        ledger_raw = read_bytes(run, "costs.sqlite3")
        ledger_path = (run / "costs.sqlite3").resolve(strict=True)
        with closing(sqlite3.connect(ledger_path.as_uri() + "?mode=ro", uri=True)) as ledger:
            ledger.row_factory = sqlite3.Row
            calls = [dict(row) for row in ledger.execute("SELECT * FROM calls ORDER BY created,id")]
            maximum = ledger.execute("SELECT maximum FROM settings WHERE id=1").fetchone()[0]
        if (any(row["state"] != "settled" for row in calls) or calls != report["costs"]["calls"]
                or maximum != nano_usd(protocol["maximumSpendUsd"])
                or nano_usd(report["costs"]["maximumUsd"]) != maximum
                or Decimal(report["costs"]["actualUsd"]) != Decimal(sum(row["actual"] for row in calls)) / NANO_USD
                or Decimal(report["costs"]["unresolvedHeldUsd"]) != 0):
            raise ValueError("Retained provider ledger must match the report and have no uncertain calls")
        identities = [{"split": "correction_source", "arm": "baseline", "domain": domain, "taskId": task}
                      for domain, tasks in selected.items() for task in tasks]
        episodes = {(row["domain"], row["taskId"]): row for row in report["episodes"]}
        if len(episodes) != 12 or set(episodes) != {(row["domain"], row["taskId"]) for row in identities}:
            raise ValueError("Source-run episodes repeat, expand or drop selected tasks")
        with tempfile.TemporaryDirectory(prefix=".fixit-review-", dir=output.parent) as temporary:
            staging = Path(temporary) / "packet"
            staging.mkdir(mode=0o700)
            files, total, candidates, coverage = [], 0, [], []

            def retain(relative: str, data: bytes) -> None:
                nonlocal total
                total += len(data)
                if total > MAX_PACKET_BYTES:
                    raise ValueError("Review packet exceeds its total evidence bound")
                target = staging / relative
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with target.open("xb") as stream:
                    os.chmod(target, 0o600)
                    stream.write(data)
                files.append({"path": relative, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})

            retain("evidence/protocol.json", protocol_raw)
            retain("evidence/report.json", report_raw)
            retain("evidence/costs.sqlite3", ledger_raw)
            for identity in identities:
                key = digest(identity)[:32]
                row = episodes[(identity["domain"], identity["taskId"])]
                if any(row.get(field) != value for field, value in identity.items()):
                    raise ValueError("Episode scope differs from its source task")
                if row["status"].startswith("not_started_"):
                    coverage.append({**identity, "status": row["status"], "eligibleFailures": 0})
                    continue
                episode_raw = read_bytes(run, f"{key}/episode.json")
                if json.loads(episode_raw) != row:
                    raise ValueError("Episode record differs from the run accounting")
                retain(f"evidence/{key}/episode.json", episode_raw)
                if row["status"] != "scored":
                    recorded = None
                    if (run / key / "tool-events.jsonl").exists():
                        raw = read_bytes(run, f"{key}/tool-events.jsonl")
                        trace = verified_trace(raw, identity, require_complete=False)
                        retain(f"evidence/{key}/tool-events.jsonl", raw)
                        recorded = trace.summary()["eligibleFailures"]
                    coverage.append({**identity, "status": row["status"], "eligibleFailures": recorded,
                                     "candidateEligibility": "unscored_episode_not_admitted"})
                    continue
                simulation_raw = read_bytes(run, f"{key}/simulation.json")
                simulation = json.loads(simulation_raw)
                if (simulation.get("id") != key or simulation.get("task_id") != identity["taskId"]
                        or simulation.get("reward_info") != row["rewardInfo"]):
                    raise ValueError("Official reward differs between episode and simulation")
                raw = read_bytes(run, f"{key}/tool-events.jsonl")
                trace = verified_trace(raw, identity)
                if trace.summary() != row["toolEvidence"]:
                    raise ValueError("Trace summary differs from the retained episode")
                retain(f"evidence/{key}/simulation.json", simulation_raw)
                retain(f"evidence/{key}/tool-events.jsonl", raw)
                contexts = {item["sha256"]: item for item in trace.records if item["kind"] == "agent_visible_context"}
                for candidate in trace.review_candidates():
                    recovery = candidate["possibleCorrectedAttempt"]
                    value = {**candidate, "id": digest([protocol["contentHash"], candidate["failure"]["sha256"]]),
                             "sourceProtocolHash": protocol["contentHash"], "officialReward": row["rewardInfo"],
                             "possibleRecoveryContext": contexts[recovery["agentContextSha256"]] if recovery else None,
                             "target": None, "reviewDecision": None}
                    relative = f"candidates/{value['id']}.json"
                    data = (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode()
                    if len(data) > MAX_FILE_BYTES:
                        raise ValueError("Candidate exceeds its evidence bound; no context is silently truncated")
                    retain(relative, data)
                    candidates.append({**identity, "id": value["id"], "path": relative,
                                       "failedTool": candidate["failedAttempt"]["call"]["name"],
                                       "hasPossibleRecovery": recovery is not None, "trainingAuthorized": False})
                coverage.append({**identity, "status": row["status"], "eligibleFailures": trace.summary()["eligibleFailures"]})
            candidate_bytes = ("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in candidates)).encode()
            retain("candidates.jsonl", candidate_bytes)
            manifest = {"schemaVersion": "openpond.fixitCorrectionReviewPacket.v1", "sourceProtocolHash": protocol["contentHash"],
                        "sourceCommit": SOURCE_COMMIT, "declaredSourceTasks": 12, "taskCoverage": coverage,
                        "candidateCount": len(candidates), "evidenceFiles": files, "evidenceBytes": total,
                        "trainingAuthorized": False, "targetsApproved": 0, "attribution": "requires_owner_review"}
            manifest["contentHash"] = digest(manifest)
            write_json(staging / "manifest.json", manifest)
            staging.rename(output)
            return manifest
