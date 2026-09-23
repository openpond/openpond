import { useEffect, useState } from "react";

import { api, type ClientConnection, type ProfileEvaluationDiscovery, type ProfileEvaluationPreparedRun, type ProfileEvaluationRunRequest } from "../../api";
import type { ProviderSettings } from "@openpond/contracts";
import "../../styles/profile/profile-page.css";

function targetLabel(target: ProfileEvaluationDiscovery["definitions"][number]["target"]): string {
  switch (target.kind) {
    case "profile": return "Complete Profile";
    case "workflow": return `Workflow · ${target.workflowId}`;
    case "skill": return `Skill · ${target.skillPath}`;
    case "agent_action": return `Agent action · ${target.actionId}`;
  }
}

function displayTimestamp(value: string): string {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? value : timestamp.toLocaleString();
}

type ModelChoice = { key: string; providerId: ProfileEvaluationRunRequest["modelRef"]["providerId"]; modelId: string; label: string };

function availableModels(settings: ProviderSettings): ModelChoice[] {
  return Object.values(settings.statuses).flatMap((status) => {
    if (!status.enabled || !status.available || !status.credential.connected) return [];
    const configured = settings.providers[status.id];
    const ids = new Set([
      ...status.modelIds,
      ...settings.modelCaches[status.id]?.models.map((model) => model.id) ?? [],
      ...configured?.modelOverrides ?? [],
      status.defaultModel,
      configured?.defaultModel,
    ].filter((id): id is string => Boolean(id)));
    return [...ids].map((modelId) => ({
      key: JSON.stringify([status.id, modelId]), providerId: status.id, modelId,
      label: `${status.displayName} · ${modelId}`,
    }));
  });
}

export function ProfileEvaluationsSection({ connection, selectedProfileKey }: {
  connection: ClientConnection | null;
  selectedProfileKey: string | null;
}) {
  const [discovery, setDiscovery] = useState<ProfileEvaluationDiscovery | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [caseLimit, setCaseLimit] = useState(50);
  const [runLimit, setRunLimit] = useState(20);
  const [comparisonLimit, setComparisonLimit] = useState(20);
  const [selectedRunIds, setSelectedRunIds] = useState<string[]>([]);
  const [comparing, setComparing] = useState(false);
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [selectedModelKey, setSelectedModelKey] = useState("");
  const [plan, setPlan] = useState<{ request: ProfileEvaluationRunRequest; prepared: ProfileEvaluationPreparedRun } | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [running, setRunning] = useState(false);
  const [runNotice, setRunNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!connection || !selectedProfileKey) {
      setDiscovery(null);
      setModels([]);
      setPlan(null);
      return;
    }
    let active = true;
    setLoading(true);
    setDiscovery(null);
    setSelectedId(null);
    setCaseLimit(50);
    setRunLimit(20);
    setComparisonLimit(20);
    setSelectedRunIds([]);
    setModels([]);
    setSelectedModelKey("");
    setPlan(null);
    setRunNotice(null);
    setError(null);
    void api.profileEvaluations(connection).then((result) => {
      if (active) setDiscovery(result);
    }).catch((caught: unknown) => {
      if (active) setError(caught instanceof Error ? caught.message : String(caught));
    }).finally(() => {
      if (active) setLoading(false);
    });
    void api.providerSettings(connection).then((settings) => {
      if (!active) return;
      const choices = availableModels(settings);
      setModels(choices);
      setSelectedModelKey(choices[0]?.key ?? "");
    }).catch((caught: unknown) => {
      if (active) setError(caught instanceof Error ? caught.message : String(caught));
    });
    return () => { active = false; };
  }, [connection, selectedProfileKey]);

  if (!selectedProfileKey) return null;
  const selected = discovery?.definitions.find((definition) => definition.id === selectedId);
  const runs = selected
    ? discovery?.runs.filter((run) => run.manifest.profileEvaluation?.definitionId === selected.id) ?? []
    : [];
  const prepareRun = async () => {
    const model = models.find((choice) => choice.key === selectedModelKey);
    if (!connection || !selected || !model || preparing) return;
    const request: ProfileEvaluationRunRequest = {
      id: `evaluation-${crypto.randomUUID()}`,
      createdAt: new Date().toISOString(),
      definitionId: selected.id,
      modelRef: { providerId: model.providerId, modelId: model.modelId },
    };
    setPreparing(true);
    setPlan(null);
    setRunNotice(null);
    setError(null);
    try {
      setPlan({ request, prepared: await api.profileEvaluationPrepare(connection, request) });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPreparing(false);
    }
  };
  const runPrepared = async () => {
    if (!connection || !plan || running) return;
    setRunning(true);
    setError(null);
    try {
      const result = await api.profileEvaluationRun(connection, plan.request);
      setDiscovery(await api.profileEvaluations(connection));
      setPlan(null);
      setRunNotice(`Run ${result.manifest.id} ${result.passed ? "passed" : "did not pass"}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRunning(false);
    }
  };
  const toggleRun = (id: string) => {
    setSelectedRunIds((current) => current.includes(id)
      ? current.filter((selectedRunId) => selectedRunId !== id)
      : [...current, id]);
  };
  const compareRuns = async () => {
    if (!connection || selectedRunIds.length < 2 || comparing) return;
    setComparing(true);
    setError(null);
    try {
      await api.profileEvaluationCompare(connection, selectedRunIds);
      setDiscovery(await api.profileEvaluations(connection));
      setSelectedRunIds([]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setComparing(false);
    }
  };
  return (
    <section aria-label="Profile evaluations" className="profile-evaluations">
      <div className="profile-workflows-header">
        <h3>Evaluations</h3>
        <p>Checks and retained results for this Profile’s released components.</p>
      </div>
      {loading ? <p>Loading evaluations…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {runNotice ? <p role="status">{runNotice}</p> : null}
      {discovery && discovery.definitions.length === 0 ? <p>No evaluations in this Profile yet.</p> : null}
      {discovery?.suites.length ? (
        <div className="profile-evaluations-suites" aria-label="Evaluation suites">
          {discovery.suites.map((suite) => (
            <div key={suite.id} className="profile-evaluations-suite">
              <strong>{suite.label}</strong>
              <span>{suite.scope === "profile" ? "Profile suite" : "Component suite"} · {suite.definitionIds.length} checks</span>
            </div>
          ))}
        </div>
      ) : null}
      {discovery?.definitions.map((definition) => {
        const latest = discovery.runs.find((run) => run.manifest.profileEvaluation?.definitionId === definition.id);
        return (
          <div className="profile-evaluations-row" key={definition.id}>
            <div>
              <strong>{definition.label}</strong>
              <p>{definition.description || targetLabel(definition.target)}</p>
              <small>{targetLabel(definition.target)} · {definition.taskIds.length} tasks · {definition.seeds.length} seeds</small>
              {latest ? <small>Latest: {latest.passed ? "Passed" : "Did not pass"} · {latest.metric.value === null ? "No score" : `${Math.round(latest.metric.value * 100)}%`} · {displayTimestamp(latest.completedAt)}</small> : null}
            </div>
            <button type="button" aria-expanded={selectedId === definition.id} onClick={() => {
              setSelectedId(selectedId === definition.id ? null : definition.id);
              setCaseLimit(50);
              setRunLimit(20);
              setPlan(null);
            }}>
              {selectedId === definition.id ? "Hide details" : "View details"}
            </button>
          </div>
        );
      })}
      {selected ? (
        <div className="profile-evaluations-detail">
          <h4>{selected.label}</h4>
          <p>Taskset {selected.tasksetRelease.id} · {selected.tasksetRelease.contentHash.slice(0, 12)}</p>
          <p>Frozen split: {selected.split} · Minimum pass rate: {Math.round(selected.criterion.minimumPassRate * 100)}%</p>
          <div className="profile-evaluations-run-form">
              <label htmlFor="profile-evaluation-model">Model</label>
              <select id="profile-evaluation-model" value={selectedModelKey} disabled={preparing || running} onChange={(event) => {
                setSelectedModelKey(event.target.value);
                setPlan(null);
              }}>
                {models.map((model) => <option key={model.key} value={model.key}>{model.label}</option>)}
              </select>
              {models.length === 0 ? <p>Connect a provider and load its models in Providers settings to run this check.</p> : null}
              <button type="button" disabled={!selectedModelKey || preparing || running} onClick={() => void prepareRun()}>
                {preparing ? "Checking run…" : "Check run setup"}
              </button>
              {plan ? (
                <div className="profile-evaluations-run-plan">
                  <strong>Run setup</strong>
                  <small>Profile source {plan.prepared.manifest.profileEvaluation?.sourceRevision.slice(0, 12)} · Harness {plan.prepared.manifest.execution.kind === "harness" ? plan.prepared.manifest.execution.harnessRelease.id : ""}</small>
                  <small>Taskset {plan.prepared.taskset.id} · {plan.prepared.manifest.population.length} attempts · {plan.prepared.manifest.limits.timeoutMs / 1_000}s per attempt</small>
                  <small>Connected app scopes: {plan.prepared.taskset.connectedAppScopes.join(", ") || "none declared"}</small>
                  <button type="button" disabled={running} onClick={() => void runPrepared()}>{running ? "Running evaluation…" : "Run evaluation"}</button>
                </div>
              ) : null}
          </div>
          <div className="profile-evaluations-cases">
            <strong>Task cases</strong>
            <ul>{selected.taskIds.slice(0, caseLimit).map((taskId) => <li key={taskId}>{taskId}</li>)}</ul>
            {selected.taskIds.length > caseLimit ? <button type="button" onClick={() => setCaseLimit((limit) => limit + 50)}>Show more cases</button> : null}
            <span>Seeds: {selected.seeds.join(", ")}</span>
          </div>
          <div className="profile-evaluations-history">
            <strong>Run history</strong>
            {runs.length === 0 ? <p>No runs for this check yet.</p> : (
              <ul>{runs.slice(0, runLimit).map((run) => (
                <li key={run.manifest.id}>
                  <span>{displayTimestamp(run.completedAt)} · {run.passed ? "Passed" : "Did not pass"} · {run.receiptRefs.length} attempts</span>
                  <small>Model {run.manifest.policy.kind === "model" ? `${run.manifest.policy.model.provider}/${run.manifest.policy.model.model}` : "fixture"} · Source {run.manifest.profileEvaluation?.sourceRevision.slice(0, 10)} · Run {run.manifest.id}</small>
                </li>
              ))}</ul>
            )}
            {runs.length > runLimit ? <button type="button" onClick={() => setRunLimit((limit) => limit + 20)}>Show more runs</button> : null}
          </div>
        </div>
      ) : null}
      {discovery && discovery.runs.length > 1 ? (
        <div className="profile-evaluations-detail" aria-label="Compare evaluation runs">
          <h4>Compare runs</h4>
          <p>Select two or more runs. Comparisons require the same Taskset, cases, environment, grading policy, limits, and runtime.</p>
          <div className="profile-evaluations-comparison-runs">
            {discovery.runs.slice(0, comparisonLimit).map((run) => (
              <label key={run.manifest.id}>
                <input type="checkbox" checked={selectedRunIds.includes(run.manifest.id)} onChange={() => toggleRun(run.manifest.id)} disabled={comparing} />
                <span>
                  <strong>{run.manifest.profileEvaluation?.definitionId ?? "Profile evaluation"} · {run.metric.value === null ? "No score" : `${Math.round(run.metric.value * 100)}%`}</strong>
                  <small>{displayTimestamp(run.completedAt)} · {run.manifest.policy.kind === "model" ? `${run.manifest.policy.model.provider}/${run.manifest.policy.model.model}` : "fixture"} · Source {run.manifest.profileEvaluation?.sourceRevision.slice(0, 10)} · {run.manifest.id}</small>
                </span>
              </label>
            ))}
          </div>
          {discovery.runs.length > comparisonLimit ? <button type="button" onClick={() => setComparisonLimit((limit) => limit + 20)}>Show more runs</button> : null}
          <button type="button" disabled={selectedRunIds.length < 2 || comparing} onClick={() => void compareRuns()}>
            {comparing ? "Comparing…" : `Save comparison of ${selectedRunIds.length} runs`}
          </button>
        </div>
      ) : null}
      {discovery && discovery.comparisons.length > 0 ? (
        <div className="profile-evaluations-detail" aria-label="Saved evaluation comparisons">
          <h4>Saved comparisons</h4>
          <ul>{discovery.comparisons.map((comparison) => (
            <li key={comparison.id}>
              <strong>{displayTimestamp(comparison.createdAt)} · {comparison.members.length} runs</strong>
              <ul>{comparison.members.map((member) => (
                <li key={member.runManifest.id}>
                  {member.source.definitionId} · {member.policy.kind === "model" ? `${member.policy.model.provider}/${member.policy.model.model}` : "fixture"} · Source {member.source.sourceRevision.slice(0, 10)} · {member.score === null ? "No score" : `${Math.round(member.score * 100)}%`}
                </li>
              ))}</ul>
            </li>
          ))}</ul>
        </div>
      ) : null}
    </section>
  );
}
