import { useQuery } from "@tanstack/react-query";
import { connectionQueryScope } from "../../../lib/query-scope";
import { executeHostedLearningCommand } from "../../../api/hosted-learning-command";
import { lazy, Suspense, useMemo, useRef, useState } from "react";
import type { ModelProject } from "@openpond/contracts";
import { learningRef, type LearningCommand } from "openpond-sdk/learning";
import type { ClientConnection } from "../../../api";
import { createHostedModelLearningApi } from "../../../api/model-learning-api";
import { modelsLocation, navigateModelsRoute } from "../lab-primary-tab-state";
import { LearningActions, LearningError, LearningPager } from "./LearningFields";

const Settings = lazy(() => import("./HostedModelLearningSettings").then(module => ({ default: module.HostedModelLearningSettings })));
const Review = lazy(() => import("./HostedModelLearningReview").then(module => ({ default: module.HostedModelLearningReview })));

export function HostedModelLearning({ connection, model, readOnly, mode = "overview" }: { mode?: "overview" | "settings"; connection: ClientConnection; model: ModelProject; readOnly: boolean }) {
  const client = useMemo(() => createHostedModelLearningApi(connection, model.id, model.profileId), [connection, model.id, model.profileId]);
  const [settingsEpoch, setSettingsEpoch] = useState(0);
  const [reviewing, setReviewing] = useState<{ policyId: string; sourceId: string } | null>(null);
  const [policyId, setPolicyId] = useState<string | undefined>();
  const [afterId, setAfterId] = useState<string | undefined>();
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<LearningCommand | null>(null);
  const active = useRef(false);
  const queryScope = ["hosted-model-learning", connectionQueryScope(connection), model.profileId, model.id, model.hosted?.teamId, model.hosted?.apiOrigin];
  const overview = useQuery({
    queryKey: [...queryScope, policyId ?? "", afterId ?? ""],
    queryFn: () => client.overview({ policyId, afterId }), staleTime: 60_000, refetchInterval: 10_000,
  });
  const value = overview.data ?? null;
  const error = overview.error?.message ?? null;
  const policy = value?.policy;
  async function run(command: LearningCommand) {
    if (active.current) return;
    active.current = true; setBusy(true); setMutationError(null);
    try {
      await executeHostedLearningCommand(client, pending, command, policy?.id);
      void overview.refetch();
    }
    catch (failure) {
      setMutationError(failure instanceof Error ? failure.message : "Unable to update hosted learning.");
    }
    finally { active.current = false; setBusy(false); }
  }
  const canCancel = value?.iteration && value.inspection?.chain?.activeIterationId === value.iteration.id
    && ["ready", "dispatching", "training", "evaluating", "failed"].includes(value.iteration.status) && value.dispatch?.state !== "settled";
  if (mode === "settings" && value) return <Suspense fallback={<p>Opening learning settings…</p>}><Settings key={`${value.policy?.id ?? "new"}:${value.policy?.revision ?? 0}:${settingsEpoch}`} inline queryScope={queryScope} client={client} project={value.project} policy={value.policy} onClose={() => { void overview.refetch().then(() => setSettingsEpoch(value => value + 1)); }} /></Suspense>;
  if (reviewing) return <Suspense fallback={<p>Opening hosted review…</p>}><Review api={client} {...reviewing} onBack={() => { setReviewing(null); void overview.refetch(); }} /></Suspense>;
  return <section className="training-detail-section models-learning-overview" aria-label="Hosted continual learning">
    <h2>Continual learning</h2>
    <LearningError error={mutationError ?? error} />
    {!readOnly && value ? <button type="button" className="training-button secondary" disabled={busy || Boolean(pending.current)} onClick={() => { void navigateModelsRoute(modelsLocation("settings", model.id)); }}>{value.policy ? "Learning settings" : "Configure learning"}</button> : null}
    {!value && !error ? <p>Loading hosted learning…</p> : null}
    {value?.policies.items.length === 0 ? <p>Continual learning is not configured.</p> : null}
    {value && value.policies.items.length > 1 ? <label>Learning policy<select value={policyId ?? ""} disabled={busy || Boolean(pending.current)} onChange={event => setPolicyId(event.target.value || undefined)}>
      <option value="">Select a policy</option>{value.policies.items.map(item => <option key={item.id} value={item.id}>{item.id} · {item.enabled ? "Enabled" : "Paused"}</option>)}
    </select></label> : null}
    {policy ? <>
      <div className="training-table-wrap"><table className="training-data-table"><thead><tr><th>Status</th><th>Updates</th><th>Ready to train</th><th>Daily limit</th><th>Next check</th></tr></thead><tbody><tr><td>{policy.enabled && policy.trigger.kind !== "manual" ? "Enabled" : "Default"}</td><td>{policy.trigger.kind === "nightly" ? `Nightly at ${policy.trigger.localTime} · ${policy.trigger.timeZone}` : policy.trigger.kind === "approved_count" ? `After ${policy.admission.minimumApprovedExamples} tasks` : policy.trigger.kind === "schedule" ? `Every ${policy.trigger.intervalSeconds / 60} minutes` : "Manual"}</td><td>{value?.inspection?.counts?.eligible ?? "—"} / {policy.admission.minimumApprovedExamples}</td><td>${policy.limits.maxDailySpendUsd}</td><td>{value?.schedule?.nextRunAt ? new Date(value.schedule.nextRunAt).toLocaleString() : "—"}</td></tr></tbody></table></div>
      <details><summary>Learning activity</summary>
      {value?.schedule?.state === "blocked" ? <LearningError error={value.schedule.lastError ?? "The schedule is blocked. Review learning settings before resuming."} /> : null}
      {value?.inspection?.blockers.length ? <ul>{value.inspection.blockers.map(item => <li key={item.code}>{item.message}</li>)}</ul> : null}
      {value?.iteration ? <p>Latest iteration: {value.iteration.status.replaceAll("_", " ")} · {value.iteration.id}</p> : null}
      {value?.iteration?.failure ? <LearningError error={value.iteration.failure.message} /> : null}
      {value?.inspection ? <p>Reserved: ${value.inspection.budget.reservedSpendUsd.toFixed(4)} · Spent: ${value.inspection.budget.settledSpendUsd.toFixed(4)} · Daily limit: ${policy.limits.maxDailySpendUsd}</p> : null}
      {value?.inspection?.trainingParent ? <details><summary>Starting checkpoint for the next iteration</summary>
        <p>{value.inspection.trainingParent.selection ? "Latest accepted candidate; optimizer state resets." : "Configured base model."}</p>
        <p>{value.inspection.trainingParent.reference.id}</p>
        <code>{value.inspection.trainingParent.reference.contentHash}</code>
      </details> : null}
      {!readOnly ? <LearningActions>
        {policy.sources.map(source => <button key={source.id} type="button" className="training-button secondary" disabled={busy || Boolean(pending.current)} onClick={() => setReviewing({ policyId: policy.id, sourceId: source.id })}>Review {source.id}</button>)}
        {pending.current ? <button type="button" className="training-button" disabled={busy} onClick={() => { if (pending.current) void run(pending.current); }}>Retry pending action</button> : <>
          <button type="button" className="training-button" disabled={busy || !value?.inspection?.canReserve} onClick={() => void run({ action: "reserve_iteration", operationId: crypto.randomUUID(), policy: learningRef(policy), trigger: { kind: "manual", identity: crypto.randomUUID() } })}>Train on approved tasks</button>
          <button type="button" className="training-button secondary" disabled={busy} onClick={() => { const { contentHash: _hash, ...content } = policy; void run({ action: "publish", operationId: crypto.randomUUID(), kind: "policy", expectedRevision: policy.revision, content: { ...content, revision: policy.revision + 1, enabled: !policy.enabled } }); }}>{policy.enabled ? "Pause learning" : "Resume learning"}</button>
          {canCancel && value?.iteration ? <button type="button" className="training-button secondary" disabled={busy} onClick={() => void run({ action: "cancel_iteration", operationId: crypto.randomUUID(), iterationId: value.iteration!.id, expectedRevision: value.iteration!.revision })}>Cancel iteration</button> : null}
          {value?.iteration && value.dispatch?.state === "blocked" ? <button type="button" className="training-button secondary" disabled={busy} onClick={() => void run({ action: "retry_iteration_dispatch", operationId: crypto.randomUUID(), iterationId: value.iteration!.id, expectedRevision: value.iteration!.revision })}>Retry iteration</button> : null}
        </>}
      </LearningActions> : null}
      </details>
    </> : null}
    {!busy && !pending.current ? <LearningPager after={afterId} next={value?.policies.nextCursor} onPage={cursor => { setAfterId(cursor ?? undefined); setPolicyId(undefined); }} /> : null}
  </section>;
}
