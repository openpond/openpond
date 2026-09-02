import { useEffect, useState } from "react";
import type { Taskset, TasksetGraderDetailsResponse } from "@openpond/contracts";

import type { useTraining } from "../../hooks/useTraining";
import { DetailSection } from "../training/DetailSection";

export function LabTasksetGraders({ taskset, training }: {
  taskset: Taskset;
  training: ReturnType<typeof useTraining>;
}) {
  const [details, setDetails] = useState<TasksetGraderDetailsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setDetails(null);
    setLoading(true);
    void training.actions.tasksetGraderDetails(taskset.id).then((value) => {
      if (!cancelled) setDetails(value);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [taskset.id, training.actions]);

  const graders = details?.graders ?? taskset.graders;
  return (
    <DetailSection title="Graders">
      <p className="labs-detail-copy">
        These graders and verifier sources are attached to Taskset revision {taskset.revision}. Source code is loaded separately from the policy-visible Taskset state.
      </p>
      <div className="training-table-wrap">
        <table className="training-data-table labs-taskset-grader-table">
          <thead><tr><th>Grader</th><th>Kind</th><th>Version</th><th>Weight</th><th>Use</th></tr></thead>
          <tbody>{graders.map((grader) => (
            <tr key={grader.id}>
              <td><strong>{grader.label}</strong><small>{grader.id}</small></td>
              <td>{grader.kind.replaceAll("_", " ")}</td>
              <td>{grader.version}</td>
              <td>{grader.weight}</td>
              <td>{[grader.rewardEligible ? "Reward" : null, grader.hardGate ? "Hard gate" : null, grader.privileged ? "Privileged" : null].filter(Boolean).join(" · ") || "Evaluation"}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>

      {details?.runtime ? (
        <section className="labs-taskset-grader-runtime">
          <h3>Runtime</h3>
          <dl className="training-configuration-list">
            <div><dt>Protocol</dt><dd>{details.runtime.protocolVersion}</dd></div>
            <div><dt>Module</dt><dd><code>{details.runtime.module}</code></dd></div>
            <div><dt>SHA-256</dt><dd><code>{details.runtime.moduleSha256}</code></dd></div>
            <div><dt>Maximum turns</dt><dd>{details.runtime.maxTurns}</dd></div>
          </dl>
        </section>
      ) : null}

      {details?.sources.map((source) => (
        <section className="labs-taskset-grader-source" key={source.path}>
          <header>
            <div><h3>{source.path}</h3><p>{source.graderId ?? "Taskset runtime grader"}</p></div>
            <span className={`labs-taskset-grader-integrity ${source.integrity}`}>{source.integrity}</span>
          </header>
          <pre aria-label={`${source.path} source code`}><code>{source.content}</code></pre>
          <small>SHA-256 {source.sha256}</small>
        </section>
      ))}

      {loading ? <div className="training-run-placeholder">Loading grader source…</div> : null}
      {!loading && details?.unavailableReason ? <div className="training-run-placeholder">{details.unavailableReason}</div> : null}
    </DetailSection>
  );
}
