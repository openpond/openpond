import { useEffect, useRef, useState } from "react";

import { api, type ClientConnection, type ProfileEvaluationDiscovery, type ProfileEvaluationPreparedRun, type ProfileEvaluationRunRequest, type ProfileWorkflowDiscovery } from "../../api";
import type { ProviderSettings } from "@openpond/contracts";
import { ProfileEvaluationComparisonMatrix } from "./ProfileEvaluationComparisonMatrix";
import "../../styles/profile/profile-page.css";
import { ProfileWorkflowsSection } from "./ProfileWorkflowsSection";
import { ProfileEvaluationRunTable } from "./ProfileEvaluationRunTable";
import { ProfileEvaluationRunDialog } from "./ProfileEvaluationRunDialog";
import { loadProfileEvaluationHistory, type ProfileEvaluationHistory } from "../../api/profile-evaluation-inspection";
import { displayScore, displayTimestamp, targetLabel, type EvaluationRun, type EvaluationTarget } from "./profile-evaluation-display";

function matchesTarget(target: EvaluationTarget, focus: ProfileEvaluationTarget): boolean {
  return target.kind === focus.kind && (focus.kind === "profile"
    || target.kind === "workflow" && target.workflowId === focus.id
    || target.kind === "skill" && target.skillPath === focus.id);
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

export type ProfileEvaluationTarget = { kind: "workflow" | "skill" | "profile"; id?: string };

export function ProfileEvaluationsSection({ connection, selectedProfileKey, focusTarget }: {
  connection: ClientConnection | null;
  selectedProfileKey: string | null;
  focusTarget?: ProfileEvaluationTarget | null;
}) {
  const sectionRef = useRef<HTMLElement>(null);
  const [workflows, setWorkflows] = useState<ProfileWorkflowDiscovery | null>(null);
  const [history, setHistory] = useState<ProfileEvaluationHistory | null>(null);
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const [evaluationScope, setEvaluationScope] = useState<ProfileEvaluationTarget | null>(null);
  const [inspectedRun, setInspectedRun] = useState<EvaluationRun | null>(null);
  const appliedFocus = useRef<ProfileEvaluationTarget | null>(null);
  const [discovery, setDiscovery] = useState<ProfileEvaluationDiscovery | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [caseLimit, setCaseLimit] = useState(50);
  const [comparisonLimit, setComparisonLimit] = useState(20);
  const [selectedRunIds, setSelectedRunIds] = useState<string[]>([]);
  const [comparing, setComparing] = useState(false);
  const [savingReportId, setSavingReportId] = useState<string | null>(null);
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [selectedModelKey, setSelectedModelKey] = useState("");
  const [plan, setPlan] = useState<{ request: ProfileEvaluationRunRequest; prepared: ProfileEvaluationPreparedRun } | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [running, setRunning] = useState(false);
  const [runningSuiteId, setRunningSuiteId] = useState<string | null>(null);
  const [runNotice, setRunNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!connection || !selectedProfileKey) {
      setDiscovery(null);
      setHistory(null);
      setWorkflows(null);
      setInspectedRun(null);
      setModels([]);
      setPlan(null);
      return;
    }
    let active = true;
    setLoading(true);
    setDiscovery(null);
    setHistory(null);
    setWorkflows(null);
    setWorkflowError(null);
    setEvaluationScope(null);
    setInspectedRun(null);
    appliedFocus.current = null;
    setSelectedId(null);
    setCaseLimit(50);
    setComparisonLimit(20);
    setSelectedRunIds([]);
    setModels([]);
    setSelectedModelKey("");
    setPlan(null);
    setRunNotice(null);
    setError(null);
    void loadProfileEvaluationHistory(connection).then(result => {
      if (active) setHistory(result);
    }).catch((caught: unknown) => {
      if (active) setError(caught instanceof Error ? caught.message : String(caught));
    });
    void api.profileWorkflows(connection).then(result => {
      if (active) setWorkflows(result);
    }).catch((caught: unknown) => {
      if (active) setWorkflowError(caught instanceof Error ? caught.message : String(caught));
    });
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

  useEffect(() => {
    if (!focusTarget || !discovery || appliedFocus.current === focusTarget) return;
    appliedFocus.current = focusTarget;
    const definition = discovery.definitions.find(entry => matchesTarget(entry.target, focusTarget));
    setEvaluationScope(focusTarget);
    setSelectedId(definition?.id ?? null);
    setPlan(null);
    setCaseLimit(50);
    setRunNotice(definition ? null : "No evaluation definition is saved for this Profile component.");
    sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [discovery, focusTarget]);

  if (!selectedProfileKey) return null;
  const selected = discovery?.definitions.find((definition) => definition.id === selectedId);
  const definitions = discovery?.definitions.filter(definition => !evaluationScope || matchesTarget(definition.target, evaluationScope)) ?? [];
  const retained = history ?? discovery;
  const evaluationCatalog = discovery ? { ...discovery, runs: retained?.runs ?? [], suiteRuns: retained?.suiteRuns ?? [] } : null;
  const runs = retained?.runs.filter(run => evaluationScope
    ? Boolean(run.manifest.profileEvaluation && matchesTarget(run.manifest.profileEvaluation.target, evaluationScope))
    : !selected || run.manifest.profileEvaluation?.definitionId === selected.id) ?? [];
  const busy = preparing || running || Boolean(runningSuiteId);
  const openWorkflowEvaluations = (workflowId: string) => {
    const scope: ProfileEvaluationTarget = { kind: "workflow", id: workflowId };
    setEvaluationScope(scope);
    setSelectedId(discovery?.definitions.find(entry => matchesTarget(entry.target, scope))?.id ?? null);
    setPlan(null);
    setRunNotice(null);
    setCaseLimit(50);
    sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
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
      const result = await api.profileEvaluationRun(connection, {
        ...plan.request, expectedManifestHash: plan.prepared.manifest.contentHash,
      });
      setPlan(null);
      setInspectedRun(result);
      setRunNotice(`Run ${result.manifest.id} ${result.passed ? "passed" : "did not pass"}.`);
      setHistory(await loadProfileEvaluationHistory(connection));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRunning(false);
    }
  };
  const runSuite = async (suiteId: string) => {
    const model = models.find((choice) => choice.key === selectedModelKey);
    if (!connection || !model || runningSuiteId) return;
    setRunningSuiteId(suiteId);
    setRunNotice(null);
    setError(null);
    try {
      const result = await api.profileEvaluationRunSuite(connection, {
        id: `suite-${crypto.randomUUID()}`,
        createdAt: new Date().toISOString(),
        suiteId,
        modelRef: { providerId: model.providerId, modelId: model.modelId },
      });
      setHistory(await loadProfileEvaluationHistory(connection));
      setRunNotice(`Suite ${result.id} ${result.passed ? "passed" : "did not pass"}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRunningSuiteId(null);
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
      setHistory(await loadProfileEvaluationHistory(connection));
      setSelectedRunIds([]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setComparing(false);
    }
  };
  const saveReport = async (kind: "run" | "suite" | "comparison", id: string) => {
    if (!connection || savingReportId) return;
    setSavingReportId(id);
    setError(null);
    try {
      const report = await api.profileEvaluationSaveReport(connection, kind, id);
      setHistory(await loadProfileEvaluationHistory(connection));
      setRunNotice(`Report ${report.id} saved to Profile source. Commit and publish the Profile when ready.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSavingReportId(null);
    }
  };
  return (
    <>
    {workflows ? <ProfileWorkflowsSection catalog={workflows} evaluations={evaluationCatalog}
      onEvaluate={openWorkflowEvaluations} onOpenRun={setInspectedRun} busy={busy} /> : null}
    {workflowError ? <p role="alert">{workflowError}</p> : null}
    <section ref={sectionRef} aria-label="Profile evaluations" className="profile-evaluations">
      <div className="profile-workflows-header">
        <h3>Evaluations</h3>
        <p>Checks and retained results for this Profile’s released components.</p>
      </div>
      {loading ? <p>Loading evaluations…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {runNotice ? <p role="status">{runNotice}</p> : null}
      {evaluationScope ? <div className="profile-evaluation-scope"><strong>{evaluationScope.kind === "workflow" ? `Workflow · ${evaluationScope.id}` : evaluationScope.kind === "skill" ? `Skill · ${evaluationScope.id}` : "Complete Profile"}</strong>
        <button type="button" disabled={busy} onClick={() => { setEvaluationScope(null); setSelectedId(null); setPlan(null); setRunNotice(null); }}>Show all evaluations</button></div> : null}
      {discovery && !definitions.length ? <p>{evaluationScope ? "No evaluation definitions target this component. Add a definition in the Profile’s evals catalog to run it. Retained runs are shown below." : "No evaluations in this Profile yet."}</p> : null}
      {discovery?.suites.length ? (
        <div className="profile-evaluations-suites" aria-label="Evaluation suites">
          <label htmlFor="profile-evaluation-suite-model">Suite model</label>
          <select id="profile-evaluation-suite-model" value={selectedModelKey} disabled={busy} onChange={(event) => { setSelectedModelKey(event.target.value); setPlan(null); }}>
            {models.map((model) => <option key={model.key} value={model.key}>{model.label}</option>)}
          </select>
          {models.length === 0 ? <p>Connect a provider and load its models in Providers settings to run a suite.</p> : null}
          {discovery.suites.map((suite) => (
            <div key={suite.id} className="profile-evaluations-suite">
              <strong>{suite.label}</strong>
              <span>{suite.scope === "profile" ? "Profile suite" : "Component suite"} · {suite.definitionIds.length} checks</span>
              <button type="button" disabled={!selectedModelKey || busy} onClick={() => void runSuite(suite.id)}>
                {runningSuiteId === suite.id ? "Running suite…" : "Run suite"}
              </button>
              {(retained?.suiteRuns ?? []).filter((run) => run.suiteId === suite.id).slice(0, 5).map((run) => (
                <details key={run.id} className="profile-evaluations-suite-run">
                  <summary>{displayTimestamp(run.completedAt)} · {run.passed ? "Passed" : "Did not pass"} · {run.members.length} checks</summary>
                  <small>Profile source {run.sourceRevision.slice(0, 12)} · Suite run {run.id}</small>
                  <button type="button" disabled={Boolean(savingReportId)} onClick={() => void saveReport("suite", run.id)}>
                    {savingReportId === run.id ? "Saving report…" : "Save report to Profile"}
                  </button>
                  <ul>{run.members.map((member) => (
                    <li key={member.runManifest.id}>
                      <strong>{run.sourceRevision === discovery.sourceRevision
                        ? discovery.definitions.find((definition) => definition.id === member.definitionId)?.label ?? member.definitionId
                        : member.definitionId}</strong>
                      <button type="button" onClick={() => {
                        const retainedRun = retained?.runs.find(run => run.manifest.id === member.runManifest.id);
                        if (retainedRun) setInspectedRun(retainedRun);
                      }} disabled={!retained?.runs.some(run => run.manifest.id === member.runManifest.id)}>View results</button>
                      <span>{member.passed ? "Passed" : "Did not pass"} · {member.score === null ? "No score" : `${Math.round(member.score * 100)}%`} · Run {member.runManifest.id}</span>
                    </li>
                  ))}</ul>
                </details>
              ))}
            </div>
          ))}
        </div>
      ) : null}
      {definitions.length ? <div className="profile-table-scroll"><table className="profile-evaluation-table">
        <thead><tr><th scope="col">Evaluation</th><th scope="col">Target</th><th scope="col">Tasks / seeds</th><th scope="col">Latest result</th><th scope="col">Actions</th></tr></thead>
        <tbody>{definitions.map(definition => {
          const latest = retained?.runs.find(run => run.manifest.profileEvaluation?.definitionId === definition.id);
          return <tr key={definition.id}>
            <th scope="row"><strong>{definition.label}</strong><small>{definition.description}</small></th>
            <td>{targetLabel(definition.target)}</td><td>{definition.taskIds.length} / {definition.seeds.length}</td>
            <td>{latest ? <button type="button" onClick={() => setInspectedRun(latest)}>{latest.passed ? "Passed" : "Did not pass"} · {displayScore(latest.metric.value)}<small>{displayTimestamp(latest.completedAt)}</small></button> : "Not run"}</td>
            <td><button type="button" disabled={busy} aria-expanded={selectedId === definition.id} onClick={() => {
              setSelectedId(current => current === definition.id ? null : definition.id);
              setCaseLimit(50); setPlan(null); setRunNotice(null);
            }}>{selectedId === definition.id ? "Hide details" : "View / Run Evaluation"}</button></td>
          </tr>;
        })}</tbody></table></div> : null}
      {selected ? (
        <div className="profile-evaluations-detail">
          <h4>{selected.label}</h4>
          <p>Taskset {selected.tasksetRelease.id} · {selected.tasksetRelease.contentHash.slice(0, 12)}</p>
          <p>Frozen split: {selected.split} · Minimum pass rate: {Math.round(selected.criterion.minimumPassRate * 100)}% · {selected.criterion.requireComplete ? "All attempts required" : "Incomplete runs allowed"}</p>
          <p>This evaluation runs the selected component against its Taskset’s frozen cases and graders.</p>
          <details><summary>Evaluation definition</summary><pre>{JSON.stringify(selected, null, 2)}</pre></details>
          <div className="profile-evaluations-run-form">
              <label htmlFor="profile-evaluation-model">Model</label>
              <select id="profile-evaluation-model" value={selectedModelKey} disabled={busy} onChange={(event) => {
                setSelectedModelKey(event.target.value);
                setPlan(null);
              }}>
                {models.map((model) => <option key={model.key} value={model.key}>{model.label}</option>)}
              </select>
              {models.length === 0 ? <p>Connect a provider and load its models in Providers settings to run this check.</p> : null}
              <button type="button" disabled={!selectedModelKey || busy} onClick={() => void prepareRun()}>
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
        </div>
      ) : null}
      {retained ? <ProfileEvaluationRunTable key={selectedId ?? JSON.stringify(evaluationScope)} runs={runs}
        definitions={discovery?.definitions ?? []} sourceRevision={discovery?.sourceRevision ?? ""} onOpen={setInspectedRun}
        onSave={id => void saveReport("run", id)} savingReportId={savingReportId} /> : null}
      {retained && retained.runs.length > 1 ? (
        <div className="profile-evaluations-detail" aria-label="Compare evaluation runs">
          <h4>Compare runs</h4>
          <p>Select two or more runs. Comparisons require the same Taskset, cases, environment, grading policy, limits, and runtime.</p>
          <div className="profile-evaluations-comparison-runs">
            {retained.runs.slice(0, comparisonLimit).map((run) => (
              <label key={run.manifest.id}>
                <input type="checkbox" checked={selectedRunIds.includes(run.manifest.id)} onChange={() => toggleRun(run.manifest.id)} disabled={comparing} />
                <span>
                  <strong>{run.manifest.profileEvaluation?.definitionId ?? "Profile evaluation"} · {run.metric.value === null ? "No score" : `${Math.round(run.metric.value * 100)}%`}</strong>
                  <small>{displayTimestamp(run.completedAt)} · {run.manifest.policy.kind === "model" ? `${run.manifest.policy.model.provider}/${run.manifest.policy.model.model}` : "fixture"} · Source {run.manifest.profileEvaluation?.sourceRevision.slice(0, 10)} · {run.manifest.id}</small>
                </span>
              </label>
            ))}
          </div>
          {retained.runs.length > comparisonLimit ? <button type="button" onClick={() => setComparisonLimit((limit) => limit + 20)}>Show more runs</button> : null}
          <button type="button" disabled={selectedRunIds.length < 2 || comparing} onClick={() => void compareRuns()}>
            {comparing ? "Comparing…" : `Save comparison of ${selectedRunIds.length} runs`}
          </button>
        </div>
      ) : null}
      {retained && retained.comparisons.length > 0 ? (
        <div className="profile-evaluations-detail" aria-label="Saved evaluation comparisons">
          <h4>Saved comparisons</h4>
          <ul>{retained.comparisons.map((comparison) => (
            <li key={comparison.id}>
              <strong>{displayTimestamp(comparison.createdAt)} · {comparison.members.length} runs</strong>
              <button type="button" disabled={Boolean(savingReportId)} onClick={() => void saveReport("comparison", comparison.id)}>
                {savingReportId === comparison.id ? "Saving report…" : "Save report to Profile"}
              </button>
              <ul>{comparison.members.map((member) => (
                <li key={member.runManifest.id}>
                  {member.source.definitionId} · {member.policy.kind === "model" ? `${member.policy.model.provider}/${member.policy.model.model}` : "fixture"} · Source {member.source.sourceRevision.slice(0, 10)} · {member.score === null ? "No score" : `${Math.round(member.score * 100)}%`}
                </li>
              ))}</ul>
              <ProfileEvaluationComparisonMatrix comparison={comparison} />
            </li>
          ))}</ul>
        </div>
      ) : null}
      {retained?.reports.length ? (
        <div className="profile-evaluations-detail" aria-label="Profile evaluation reports">
          <h4>Reports saved in Profile source</h4>
          <ul>{retained.reports.map((report) => (
            <li key={report.id}>
              <strong>{displayTimestamp(report.createdAt)} · {report.summary.passedChecks}/{report.summary.totalChecks} checks passed</strong>
              <small>Tested source {report.testedSources.map((source) => source.sourceRevision.slice(0, 10)).join(", ")} · Evidence {report.evidence.map((ref) => ref.id).join(", ")}</small>
            </li>
          ))}</ul>
        </div>
      ) : null}
    </section>
    {connection && inspectedRun ? <ProfileEvaluationRunDialog key={inspectedRun.manifest.id} connection={connection} run={inspectedRun} onClose={() => setInspectedRun(null)} /> : null}
    </>
  );
}
