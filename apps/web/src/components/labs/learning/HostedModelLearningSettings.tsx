import { useQuery, type QueryKey } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { createHostedLearningPolicyContent, hostedLearningPolicyDefaults, learningRef, sameLearningRef,
  type LearningPolicy, type LearningRevisionRef, type LearningSource, type LearningCommand } from "openpond-sdk/learning";
import type { HostedModelProjectSummary } from "openpond-sdk/model-projects";
import { ApiRequestError } from "../../../api/api-client";
import type { createHostedModelLearningApi } from "../../../api/model-learning-api";
import { AppDialog } from "../../dialogs/AppDialog";
import { useDraftNavigation } from "../useDraftNavigation";
import { LearningError, LearningPager } from "./LearningFields";

type Client = ReturnType<typeof createHostedModelLearningApi>;
export function HostedModelLearningSettings({ client, project, policy, queryScope, onClose }: {
  client: Client; queryScope: QueryKey; project: HostedModelProjectSummary; policy: LearningPolicy | null; onClose: () => void;
}) {
  const [id] = useState(() => policy?.id ?? `policy-${crypto.randomUUID()}`);
  const [defaults] = useState(() => hostedLearningPolicyDefaults(project, policy));
  const [enabled, setEnabled] = useState(defaults.enabled);
  const [scheduled, setScheduled] = useState(defaults.scheduled);
  const [applyModel, setApplyModel] = useState(!policy);
  const [human, setHuman] = useState(defaults.humanReviewRequired);
  const [sources, setSources] = useState(policy?.sources ?? []);
  const [definition, setDefinition] = useState<LearningRevisionRef | null>(policy?.taskDefinition ?? null);
  const [fields, setFields] = useState({ interval: String(defaults.intervalSeconds / 60), minimum: String(defaults.minimumApprovedExamples),
    batch: String(defaults.maxBatchExamples), spend: String(defaults.maxIterationSpendUsd),
    daily: String(defaults.maxDailySpendUsd), cooldown: String(defaults.cooldownSeconds / 60),
    retries: String(defaults.maxRetries), backlog: String(defaults.maxBacklogExamples) });
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [after, setAfter] = useState<string | undefined>();
  const catalog = useQuery({ queryKey: [...queryScope, "sources", after ?? ""], queryFn: () => client.sources(after) });
  const catalogError = catalog.error?.message ?? null;
  const pending = useRef<LearningCommand | null>(null);
  const active = useRef(false);
  const current = catalog.data ?? null;
  const binding = applyModel ? project.trainingSetup.rewardBindingRef : policy?.rewardBinding;
  function select(source: LearningSource) {
    const selected = sources.some(ref => ref.id === source.id);
    setSources(selected ? sources.filter(ref => ref.id !== source.id) : [...sources, learningRef(source)]);
    setDefinition(selected && sources.length === 1 ? null : definition ?? source.taskDefinition); setDirty(true);
  }
  async function save() {
    if (active.current) return false;
    active.current = true; setBusy(true); setError(null);
    try {
      if (!pending.current) {
        if (!definition || !sources.length || !binding) throw new Error("Select task sources and a Model grader before saving.");
        const content = createHostedLearningPolicyContent({ project, previous: policy, policyId: id, applyModelConfiguration: applyModel,
          sources, taskDefinition: definition, settings: {
            enabled, scheduled, humanReviewRequired: human, intervalSeconds: Number(fields.interval) * 60,
            minimumApprovedExamples: Number(fields.minimum), maxBatchExamples: Number(fields.batch),
            maxIterationSpendUsd: Number(fields.spend), maxDailySpendUsd: Number(fields.daily),
            cooldownSeconds: Number(fields.cooldown) * 60, maxRetries: Number(fields.retries), maxBacklogExamples: Number(fields.backlog),
          },
        });
        pending.current = { action: "publish", kind: "policy", operationId: crypto.randomUUID(), expectedRevision: policy?.revision ?? 0, content };
      }
      await client.command(pending.current); pending.current = null; setDirty(false); return true;
    } catch (failure) {
      if (failure instanceof ApiRequestError && failure.status >= 400 && failure.status < 500 && ![408, 429].includes(failure.status)) pending.current = null;
      setError(failure instanceof Error ? failure.message : "Unable to save learning settings."); return false;
    } finally { active.current = false; setBusy(false); }
  }
  const guard = useDraftNavigation({ name: "learning settings", dirty, busy, save });
  return <><AppDialog ariaLabel="Continual learning settings" className="labs-rename-dialog learning-workspace hosted-learning-settings" backdropClassName="labs-rename-backdrop" dismissDisabled={busy} onClose={() => { void guard.requestLeave(onClose); }}>
    <h2>Continual learning settings</h2><p>Train {project.name} from approved tasks. Acceptance and serving remain separate decisions.</p>
    <LearningError error={error ?? catalogError} />
    <form onSubmit={async event => { event.preventDefault(); if (await save()) { guard.allowNextNavigation(); onClose(); } }}>
      <fieldset disabled={busy || Boolean(pending.current)} onChange={() => setDirty(true)}>
        <label><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /> Enable learning</label>
        <label><input type="checkbox" checked={human} disabled={human} onChange={() => setHuman(true)} /> Human review required</label>
        <p>New policies require human review. Qualified automatic admission cannot be configured here yet.</p>
        {policy ? <label><input type="checkbox" checked={applyModel} onChange={event => setApplyModel(event.target.checked)} /> Use the Model’s current training configuration</label> : null}
        <fieldset><legend>Task sources</legend>{!current && !catalogError ? <p>Loading sources…</p> : null}
          {current?.sources.items.map(source => {
            const format = current.definitions.find(item => sameLearningRef(learningRef(item), source.taskDefinition));
            const compatible = Boolean(binding && format && sameLearningRef(binding, format.rewardBinding) && (!definition || sameLearningRef(definition, source.taskDefinition)));
            const selected = sources.find(ref => ref.id === source.id);
            return <label key={source.id}><input type="checkbox" checked={Boolean(selected)} disabled={!selected && (!source.enabled || !compatible)} onChange={() => select(source)} /> {source.name}
              {selected && selected.revision !== source.revision ? <small>Using saved revision {selected.revision}; clear and reselect to update.</small> : !compatible ? <small>Different task format or Reward.</small> : null}</label>;
          })}
          <p>{sources.length} sources selected. <button type="button" onClick={() => { setSources([]); setDefinition(null); setDirty(true); }}>Clear selection</button></p>
          <LearningPager after={after} next={current?.sources.nextCursor} onPage={value => setAfter(value ?? undefined)} />
        </fieldset>
        <label><input type="checkbox" checked={scheduled} onChange={event => setScheduled(event.target.checked)} /> Schedule training</label>
        {(Object.keys(fields) as Array<keyof typeof fields>).filter(key => key !== "interval" || scheduled).map(key => <label key={key}>{({ interval: "Check interval (minutes)", minimum: "Minimum approved examples", batch: "Maximum examples per batch", spend: "Maximum spend per iteration ($)", daily: "Maximum daily spend ($)", cooldown: "Cooldown (minutes)", retries: "Automatic retries", backlog: "Maximum backlog" })[key]}
          <input type="number" value={fields[key]} min="0" step={key === "spend" || key === "daily" ? "0.01" : "1"} onChange={event => setFields(value => ({ ...value, [key]: event.target.value }))} /></label>)}
      </fieldset>
      <div className="model-build-actions"><button type="submit" className="training-button" disabled={busy}>{busy ? "Saving…" : pending.current ? "Retry save" : "Save settings"}</button><button type="button" className="training-button secondary" disabled={busy} onClick={() => { void guard.requestLeave(onClose); }}>Cancel</button></div>
    </form>
  </AppDialog>{guard.dialog}</>;
}
