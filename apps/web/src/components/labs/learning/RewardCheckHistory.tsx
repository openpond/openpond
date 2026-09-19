import type { OpenPondLearningClient } from "openpond-sdk/learning";
import { useState } from "react";
import { learningRef, sameLearningRef, type AuthoringDraftFor, type LearningRevisionRef, type RewardCheckRun } from "openpond-sdk/learning";
import { LearningActions, LearningError } from "./LearningFields";
import { useLearningMutation, useLearningResource, useLearningResources } from "./useLearningResources";

export function RewardCheckHistory({ client, targetId, draft, published, unchanged, busy, onCheck, checking = false, readOnly = false }: {
  client: OpenPondLearningClient | null; targetId: string; draft: AuthoringDraftFor<"reward"> | null; unchanged: boolean; busy: boolean;
  onCheck?: () => Promise<RewardCheckRun | null>; published?: LearningRevisionRef; checking?: boolean; readOnly?: boolean;
}) {
  const [cursor, setCursor] = useState<string | undefined>();
  const [startedId, setStartedId] = useState<string | null>(null);
  const started = useLearningResource(client, "reward_check", startedId, undefined, true);
  const history = useLearningResources(client, "reward_check", { parentId: targetId, limit: 25, ...(cursor ? { afterId: cursor } : {}) }, true);
  const mutation = useLearningMutation(client);
  const unique = new Map((history.page?.items ?? []).map(check => [check.id, check]));
  if (started.resource) unique.set(started.resource.id, started.resource);
  const rows = [...unique.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const currentCheckRunning = draft && unchanged && rows.some(check => sameLearningRef(check.draft, learningRef(draft)) && ["queued", "running", "cancelling"].includes(check.status));
  async function run() { const result = await onCheck?.(); if (result) { setStartedId(result.id); setCursor(undefined); history.refresh(); } }
  async function cancel(check: RewardCheckRun) {
    const result = await mutation.command({ action: "cancel_reward_check", operationId: crypto.randomUUID(), checkId: check.id, expectedRevision: check.revision });
    if (result) history.refresh();
  }
  return <section aria-label="Reward fixture checks">
    <h3>Fixture checks</h3>
    <p>Results apply to the saved source and examples they checked. Publishing remains a separate action.</p>
    <LearningError error={history.error ?? started.error ?? mutation.error} />
    {onCheck ? <LearningActions><button type="button" className="training-button secondary" disabled={busy || mutation.busy || Boolean(currentCheckRunning)} onClick={() => { void run(); }}>{checking ? "Queuing check…" : currentCheckRunning ? "Checking fixtures…" : "Check fixtures"}</button></LearningActions> : null}
    {history.loading && !history.page ? <p role="status">Loading checks…</p> : null}
    <div className="models-table-wrap"><table className="models-data-table"><thead><tr><th>Result</th><th>Checked version</th><th>Time</th><th>Details</th></tr></thead><tbody>{rows.map(check => {
      const current = draft && unchanged && sameLearningRef(check.draft, learningRef(draft));
      return <tr key={check.id}><td>
        <strong>{check.status === "completed" ? check.matchesExpectations ? "All fixtures matched" : "Fixture mismatch" : check.status}</strong>
        {check.failure ? <p role="status">{check.failure}</p> : null}
      </td><td>{current ? "Current saved draft" : published && sameLearningRef(published, check.reward) ? `Published release ${published.revision}` : `Draft revision ${check.draft.revision}`}</td><td>{new Date(check.createdAt).toLocaleString()}</td><td>
        <RewardCheckDetails client={client} check={check} />
      {!readOnly && ["queued", "running"].includes(check.status) ? <button type="button" className="training-button secondary" disabled={mutation.busy} onClick={() => { void cancel(check); }}>Cancel check</button> : null}</td></tr>;
    })}{!rows.length && !history.loading ? <tr><td colSpan={4} className="text-muted-foreground">No checks recorded.</td></tr> : null}</tbody></table></div>
    {history.page?.nextCursor ? <button type="button" className="training-button secondary" onClick={() => setCursor(history.page!.nextCursor!)}>More checks</button> : null}
    {cursor ? <button type="button" className="training-button secondary" onClick={() => setCursor(undefined)}>First page</button> : null}
  </section>;
}

function RewardCheckDetails({ client, check }: { client: OpenPondLearningClient | null; check: RewardCheckRun }) {
  const [open, setOpen] = useState(false);
  const snapshot = useLearningResource(client, "draft", open ? check.draft.id : null, check.draft.revision);
  const fixtures = snapshot.resource?.targetKind === "reward" ? snapshot.resource.fields.fixtures ?? [] : [];
  return <details onToggle={event => setOpen(event.currentTarget.open)}><summary>View results ({check.results.length}/{check.fixtureRefs.length})</summary>
    <LearningError error={snapshot.error} />
    <ul>{check.results.map(result => {
      const fixture = fixtures.find(fixture => fixture.id === result.fixture.id);
      return <li key={result.fixture.id}>
        <strong>{fixture?.name ?? result.fixture.id}</strong>
        <p>{result.result.status}{result.result.rawScore === null ? "" : ` · score ${result.result.rawScore}`} · {result.matchesExpectation ? "Matched expectation" : "Did not match expectation"}</p>
        {result.result.message ? <p>{result.result.message}</p> : null}
        {fixture ? <details><summary>Checked example</summary><p>Expected {fixture.expectedStatus}{fixture.expectedStatus === "scored" ? ` · score ${fixture.minimumScore}–${fixture.maximumScore} · passed ${fixture.expectedPassed}` : ""}</p>
          <h4>Input</h4><pre>{fixture.input}</pre><h4>Output</h4><pre>{fixture.output}</pre><h4>Expected answer</h4><pre>{fixture.expectedOutput || "None"}</pre>
        </details> : null}
      </li>;
    })}</ul>
    {check.runtime ? <details><summary>Execution details</summary><p>{check.runtime.id} · Evals {check.runtime.packageVersion} · {check.runtime.engine}</p><p>Source and fixture snapshot: {check.snapshotHash}</p></details> : null}
  </details>;
}
