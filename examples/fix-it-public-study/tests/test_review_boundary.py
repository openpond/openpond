"""Hold-out records or changed execution evidence must never become a corpus.

This is a synthetic, temporary handoff fixture, not a benchmark execution or
evidence of a natural model failure. No model or provider is contacted.
"""

import json
import tempfile
import unittest
from pathlib import Path
from tau2.data_model.message import ToolCall, ToolMessage

from fixit_study.budget import CallBudget
from fixit_study.plan import SOURCE_COMMIT, selected_tasks
from fixit_study.review import export_review_packet
from fixit_study.traces import ToolTrace, digest


class CorpusBoundary(unittest.TestCase):
    def test_unapproved_source_packet_rejects_holdout_and_changed_trace(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run = root / "synthetic-source-fixture"
            run.mkdir()
            _, selected = selected_tasks("correction_source")
            protocol = {"schemaVersion": "openpond.fixitBaselineProtocol.v1", "split": "correction_source",
                        "arm": "baseline", "sourceCommit": SOURCE_COMMIT, "maximumSpendUsd": "20",
                        "configs": [{"domain": domain, "language": "en", "task_ids": ids} for domain, ids in selected.items()]}
            protocol["contentHash"] = digest(protocol)
            (run / "protocol.json").write_text(json.dumps(protocol))
            budget = CallBudget(run / "costs.sqlite3", "20")
            costs = budget.summary()
            budget.close()
            episodes = [{"split": "correction_source", "arm": "baseline", "domain": domain, "taskId": task,
                         "status": "not_started_budget_or_uncertainty"}
                        for domain, tasks in selected.items() for task in tasks]
            identity = {key: episodes[0][key] for key in ("split", "arm", "domain", "taskId")}
            directory = run / digest(identity)[:32]
            directory.mkdir()
            trace = ToolTrace(directory / "tool-events.jsonl", identity)
            trace.initial = {"agentDatabaseHash": "fixture-initial-state", "userDatabaseHash": None}
            trace.append({"kind": "initialized", **trace.initial})
            for failed in (True, False):
                context = trace.append({"kind": "agent_visible_context", "messages": [{"role": "user", "content": "Synthetic boundary fixture"}], "tools": []})
                call = ToolCall(id=str(failed), name="fixture_tool", arguments={}).model_dump(mode="json")
                result = ToolMessage(id=str(failed), role="tool", error=failed, content="Synthetic boundary result", timestamp="2026-01-01T00:00:00Z").model_dump(mode="json")
                attempt = trace.append({"kind": "attempt", "call": call, "agentContextSha256": context["sha256"]})
                trace.append({"kind": "observation", "attemptSha256": attempt["sha256"], "result": result})
            episodes[0].update(status="scored", rewardInfo={"reward": 1}, toolEvidence=trace.summary())
            (directory / "episode.json").write_text(json.dumps(episodes[0]))
            (directory / "simulation.json").write_text(json.dumps({"id": directory.name, "task_id": identity["taskId"], "reward_info": episodes[0]["rewardInfo"]}))
            report = {"schemaVersion": "openpond.fixitBaselineRun.v1", "protocolHash": protocol["contentHash"],
                      "split": "correction_source", "declaredTaskCount": 12, "episodes": episodes, "costs": costs}
            (run / "report.json").write_text(json.dumps(report))
            packet = root / "review"
            receipt = export_review_packet(run, packet)
            self.assertEqual((receipt["declaredSourceTasks"], receipt["candidateCount"], receipt["targetsApproved"]), (12, 1, 0))
            index = json.loads((packet / "candidates.jsonl").read_text())
            candidate = json.loads((packet / index["path"]).read_text())
            self.assertFalse(candidate["trainingAuthorized"])
            self.assertIsNone(candidate["target"])
            self.assertIsNone(candidate["reviewDecision"])
            self.assertIsNotNone(candidate["possibleRecoveryContext"])
            protocol["split"] = "test"
            protocol["contentHash"] = digest({key: value for key, value in protocol.items() if key != "contentHash"})
            (run / "protocol.json").write_text(json.dumps(protocol))
            with self.assertRaises(ValueError):
                export_review_packet(run, root / "holdout-must-not-export")
            protocol["split"] = "correction_source"
            protocol["contentHash"] = digest({key: value for key, value in protocol.items() if key != "contentHash"})
            (run / "protocol.json").write_text(json.dumps(protocol))
            path = directory / "tool-events.jsonl"
            path.write_text(path.read_text().replace("Synthetic boundary result", "Changed result", 1))
            with self.assertRaises(ValueError):
                export_review_packet(run, root / "changed-evidence-must-not-export")


if __name__ == "__main__":
    unittest.main()
