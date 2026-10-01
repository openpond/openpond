import { useState } from "react";
import {
  LocalExperimentPublicExecutionSchema,
  LocalExperimentRetainedScoreSchema,
  type LocalExperimentRecord,
  type LocalExperimentPublicExecution,
} from "@openpond/contracts";
import { WorkspacePanel, useWorkspaceActions } from "./WorkspacePanel";
import { DatasetSetupGraders } from "./DatasetSetupGraders";
import { EvaluationCard } from "./EvaluationPresentation";
import { useDraftNavigation } from "../useDraftNavigation";
import { localRequest } from "./local-workspace-api";
import type { WorkspaceApi } from "./workspace-api";
export function LocalExperimentGrading({
  api,
  definition,
  execution,
  busy,
  onApply,
}: {
  api: WorkspaceApi;
  definition: LocalExperimentRecord;
  execution: LocalExperimentPublicExecution;
  busy: boolean;
  onApply: (action: () => Promise<LocalExperimentPublicExecution>) => void;
}) {
  const [open, setOpen] = useState(false),
    [budget, setBudget] = useState(5);
  const initial = definition.graders.map(({ id, version, contentHash, mappings }) => ({
    id,
    version,
    contentHash,
    mappings: mappings ?? [],
  }));
  const [selected, setSelected] = useState(initial),
    [baseline, setBaseline] = useState(JSON.stringify({ selected: initial, budget: 5 }));
  const guard = useDraftNavigation({
    name: "Retained output grading",
    dirty: open && JSON.stringify({ selected, budget }) !== baseline,
    busy: open && busy,
    onLeave: () => setOpen(false),
  });
  const select = useWorkspaceActions([
    { id: "grader", label: "Grader", onSelect: () => setOpen(true) },
  ]);
  async function apply() {
    const request = {
      execution: { id: execution.id, executionHash: execution.executionHash },
      graders: selected,
      maximumCostUsd: budget,
    };
    const operation = await api.localOperation("scoreRetained", request);
    const pass = await localRequest(
      api,
      LocalExperimentPublicExecutionSchema,
      "scoreRetained",
      LocalExperimentRetainedScoreSchema.parse({ ...request, operationId: operation.id }),
    );
    await operation.acknowledge();
    setBaseline(JSON.stringify({ selected, budget }));
    guard.allowNextNavigation();
    setOpen(false);
    return pass;
  }
  return (
    <>
      <button
        type="button"
        className="training-button secondary"
        disabled={busy || !execution.completedAt || !execution.cleanupComplete}
        onClick={() => select("grader")}
      >
        Apply retained graders
      </button>
      {open ? (
        <WorkspacePanel action="grader" label="Local retained output grading" onRequestClose={() => void guard.requestLeave(() => setOpen(false))}>
          <header>
            <h2>Apply grader</h2>

          </header>
          <EvaluationCard title="Retained execution">
            <p>
              {definition.configuration.request.name} · {execution.id}
            </p>
            <p>This pass grades retained output and makes no target call.</p>
          </EvaluationCard>
          <EvaluationCard title="Exact Dataset graders">
            <DatasetSetupGraders
              graders={definition.availableGraders}
              selected={selected}
              onChange={setSelected}
            />
          </EvaluationCard>
          <EvaluationCard title="Grading budget">
            <label>
              Whole grading ceiling ($)
              <input
                type="number"
                min="0.000001"
                max="10000"
                step="0.000001"
                value={budget}
                onChange={(event) => setBudget(Number(event.target.value))}
              />
            </label>
          </EvaluationCard>
          <button
            type="button"
            className="training-button"
            disabled={busy || !selected.length || !(budget > 0)}
            onClick={() => onApply(apply)}
          >
            Grade retained output
          </button>
          {guard.dialog}
        </WorkspacePanel>
      ) : null}
    </>
  );
}
