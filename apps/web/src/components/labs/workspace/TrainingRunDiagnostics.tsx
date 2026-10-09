import { useState } from "react";
import { contentHash } from "@openpond/harness";
import { diagnosticEvent, diagnosticFailure, sealRunDiagnostics } from "openpond-sdk/experiments";
import type { TrainingJob, TrainingJobEvent } from "openpond-sdk/training";
import { RunDiagnosticsView } from "./RunDiagnosticsView";
import "../../../styles/labs/run-diagnostics.css";
export function TrainingRunDiagnostics({
  job,
  events,
  onRefresh,
}: {
  job: TrainingJob;
  events: TrainingJobEvent[];
  onRefresh: () => void;
}) {
  const [limit, setLimit] = useState(100);
  const observed = events.slice(0, limit),
    pages = [];
  for (let index = 0; index < Math.max(1, Math.ceil(observed.length / 100)); index++) {
    const items = observed.slice(index * 100, (index + 1) * 100);
    pages.push(
      sealRunDiagnostics({
        schemaVersion: "openpond.runDiagnostics.v1",
        teamId: job.teamId,
        runId: job.id,
        location: "hosted",
        manifestHash: job.submissionHash,
        observedAt: new Date().toISOString(),
        status: job.state,
        startedAt: null,
        completedAt: job.completedAt,
        error: diagnosticFailure(job.terminalReason),
        resultAvailable: false,
        parent: null,
        accounting: {
          maximumUsd: null,
          settledUsd: null,
          outstandingUsd: null,
          outstandingCount: null,
          final: false,
          receiptCount: 0,
        },
        events: items.map((event) =>
          diagnosticEvent({
            id: event.id,
            sequence: event.sequence,
            at: event.createdAt,
            type: `training.${event.type}`,
            payload: { action: event.phase },
          }),
        ),
        nextEventCursor: null,
        eventCount: events.length,
        calls: [],
        nextCallCursor: null,
        callCount: 0,
        limitations: [
          "Identity is the immutable training submission hash; grading and output evidence remain in Evals and Outputs.",
          `Observed accrued spend: $${job.accruedSpendUsd.toFixed(6)}. This is not a finalized provider receipt.`,
          "Training creation is not an execution start; elapsed execution time is unavailable.",
          "This training contract does not retain per-call billing, lease state or paired phase timings. Missing metadata stays unknown.",
          `Evidence snapshot: ${contentHash({ id: job.id, version: job.version, eventIds: items.map((event) => event.id) })}.`,
        ],
      }),
    );
  }
  return (
    <RunDiagnosticsView
      pages={pages}
      loading={false}
      more={limit < events.length && limit < 2000}
      onMore={() => setLimit((value) => Math.min(value + 100, 2000))}
      onRefresh={onRefresh}
      onAnalyze={(prompt) => {
        window.dispatchEvent(new CustomEvent("openpond:diagnostic-draft", { detail: { prompt } }));
      }}
    />
  );
}
