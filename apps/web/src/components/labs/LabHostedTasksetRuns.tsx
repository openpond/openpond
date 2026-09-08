import { useEffect, useState } from "react";
import type { ModelProject } from "@openpond/contracts";
import type { ModelTasksetRunPageSchema, ModelTasksetRunResult } from "openpond-sdk/model-taskset-runs";
import { api, type ClientConnection } from "../../api";

type Page = ReturnType<typeof ModelTasksetRunPageSchema.parse>;
export function LabHostedTasksetRuns({ model, connection }: { model: ModelProject; connection: ClientConnection | null }) {
  const [page, setPage] = useState<Page | null>(null);
  const [after, setAfter] = useState<string | null>(null);
  const [result, setResult] = useState<ModelTasksetRunResult | null>(null);
  const [visible, setVisible] = useState(50);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `/models/${encodeURIComponent(model.id)}/hosted-evaluations`;
  const query = `profileId=${encodeURIComponent(model.profileId)}`;
  // Synchronize with the durable hosted owner; never dispatch work from polling.
  useEffect(() => {
    if (!connection) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        // The Desktop server verifies SDK schemas, hashes and Model ownership.
        const value = await api.trainingRequest<Page>(connection, `${base}?${query}${after ? `&afterId=${encodeURIComponent(after)}` : ""}`, {}, "GET");
        if (!stopped) { setPage(value); setError(null); }
      } catch (cause) { if (!stopped) setError(cause instanceof Error ? cause.message : "Hosted evaluations could not be loaded."); }
      finally { if (!stopped) timer = setTimeout(() => void load(), 5_000); }
    };
    void load();
    return () => { stopped = true; clearTimeout(timer); };
  }, [connection, base, query, after]);
  async function open(id: string) {
    if (!connection || busy) return;
    setBusy(true); setError(null);
    try { setResult(await api.trainingRequest<ModelTasksetRunResult>(connection, `${base}/${encodeURIComponent(id)}/result?${query}`, {}, "GET")); setVisible(50); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The hosted result could not be read."); }
    finally { setBusy(false); }
  }
  async function cancel(id: string) {
    if (!connection || busy) return;
    setBusy(true); setError(null);
    try {
      await api.trainingRequest(connection, `${base}/${encodeURIComponent(id)}/cancel?${query}`, {}, "POST");
      setPage(await api.trainingRequest<Page>(connection, `${base}?${query}${after ? `&afterId=${encodeURIComponent(after)}` : ""}`, {}, "GET"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The hosted evaluation could not be cancelled."); }
    finally { setBusy(false); }
  }
  return <section className="training-detail-section">
    <h2>Hosted evaluation runs</h2>
    <p>These evaluations continue in Sandbox while Desktop is closed.</p>
    {error ? <p role="alert">{error}</p> : null}
    {!page && !error ? <p role="status">Loading hosted evaluations…</p> : null}
    <div className="training-table-wrap"><table className="training-data-table"><thead><tr><th>Run</th><th>Taskset</th><th>Status</th><th>Metric</th><th>Actions</th></tr></thead><tbody>{page?.items.map(run => <tr key={run.id}><td>{run.policyKind === "fixture" ? "Fixture check" : "Model evaluation"}<small>{run.totalCount} attempts</small></td><td>Revision {run.taskset.revision}</td><td>{run.status} · {run.counts.completed + run.counts.failed + run.counts.cancelled}/{run.totalCount}</td><td>{run.metricName}: {run.score === null ? "Not scored" : run.score}</td><td>{run.resultAvailable ? <button className="training-text-button" type="button" disabled={busy} onClick={() => void open(run.id)}>View hosted result</button> : null}{["queued", "running", "cancelling"].includes(run.status) ? <button className="training-text-button" type="button" disabled={busy || run.status === "cancelling"} onClick={() => void cancel(run.id)}>{run.status === "cancelling" ? "Cancelling…" : "Cancel"}</button> : null}{run.error ? <p>{run.error.message}</p> : null}</td></tr>)}{page && !page.items.length ? <tr><td colSpan={5}>No hosted evaluations yet.</td></tr> : null}</tbody></table></div>
    {after ? <button className="training-text-button" type="button" onClick={() => { setAfter(null); setPage(null); }}>Latest evaluations</button> : null}{page?.nextCursor ? <button className="training-text-button" type="button" onClick={() => { setAfter(page.nextCursor); setPage(null); }}>Older evaluations</button> : null}
    {result ? <div className="training-detail-section"><button className="training-text-button" type="button" onClick={() => setResult(null)}>Close hosted result</button><h3>{result.run.request.policy.kind === "fixture" ? "Fixture check results" : "Hosted model evaluation"}</h3><p>{result.run.summary.status} · {result.run.summary.cleanupComplete ? "Cleanup complete" : "Cleanup unconfirmed"} · {result.run.summary.metricName}: {result.metric?.value === null || !result.metric ? "Not scored" : result.metric.value}</p>{result.run.request.policy.kind === "fixture" ? <p>Fixtures check authored execution and grading. They do not measure a model.</p> : null}
      <ul>{result.receipts.slice(0, visible).map(receipt => <li key={receipt.id}>{receipt.taskId} · Seed {receipt.seed} · {typeof receipt.metadata.score === "number" ? `${Math.round(receipt.metadata.score * 100)}%` : "Not scored"} · {receipt.failureClass?.replaceAll("_", " ") ?? "Completed"}</li>)}</ul>{visible < result.receipts.length ? <button className="training-text-button" type="button" onClick={() => setVisible(count => count + 50)}>Show more attempts</button> : null}
      <details><summary>Verified run identity</summary><pre>{JSON.stringify({ id: result.run.summary.id, taskset: result.run.request.taskset, manifestHash: result.run.manifest.contentHash, resultHash: result.contentHash, metric: result.metric }, null, 2)}</pre></details>
    </div> : null}
  </section>;
}
