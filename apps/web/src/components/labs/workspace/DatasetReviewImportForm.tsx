import { useEffect, useRef, useState } from "react";
import type {
  DatasetTrainingReviewSource,
  DatasetTrainingReviewReceipt,
} from "openpond-sdk/taskset-packages";
import type { DatasetTrainingReviewRequest } from "openpond-sdk/training";
import {
  assertLearningContentHash,
  LearningJsonObjectSchema,
  learningRef,
  type OpenPondLearningClient,
  type TaskDefinition,
} from "openpond-sdk/learning";
import type { DatasetPopulationPage } from "openpond-sdk/dataset-workspaces";
import { DropdownSelect } from "../../DropdownSelect";
import { ErrorToast } from "../../common/ErrorToast";
import { useDraftNavigation } from "../useDraftNavigation";
import { LearningJsonField, LearningPager, parseLearningObject } from "../learning/LearningFields";
import { useLearningResources } from "../learning/useLearningResources";
import { EvaluationCard } from "./EvaluationPresentation";
import { DatasetReviewTaskSelection } from "./DatasetReviewTaskSelection";
import { useDatasetReviewImport } from "./useDatasetReviewImport";
import type { WorkspaceApi } from "./workspace-api";

export function DatasetReviewImportForm({
  api,
  client,
  source: loaded,
  tasks,
  method,
  beforeImport,
  initialSelection,
  onLocked,
  onImported,
}: {
  api: WorkspaceApi;
  client: OpenPondLearningClient;
  source: DatasetTrainingReviewSource;
  tasks: DatasetPopulationPage["items"];
  method: "sft" | "grpo" | "engram_adapter" | "decision_model" | "alphaedit" | "selective_neuron_training";
  beforeImport?: () => Promise<void>;
  initialSelection: string[] | null;
  onLocked(value: boolean): void;
  onImported(receipt: DatasetTrainingReviewReceipt): void;
}) {
  // Pin the first immutable read; background refresh never overwrites edits.
  const [source] = useState(loaded);
  const [selected, setSelected] = useState(() => initialSelection ?? tasks.map((task) => task.id));
  const [format, setFormat] = useState<TaskDefinition | null>(null);
  const [instructions, setInstructions] = useState(source.definition.instructions ?? "");
  const [output, setOutput] = useState(
    source.definition.outputSchema ? JSON.stringify(source.definition.outputSchema, null, 2) : "",
  );
  const [targetSource, setTargetSource] = useState<"none" | "expected_output" | "approved_parent">(
    method !== "grpo" ? "expected_output" : "none",
  );
  const [shared, setShared] = useState(false);
  const [after, setAfter] = useState<string | null>(null);
  const formats = useLearningResources(client, "definition", {
    limit: 30,
    ...(after ? { afterId: after } : {}),
  });
  const mutation = useDatasetReviewImport(api, client, beforeImport);
  const locked = mutation.busy || mutation.attempted || Boolean(mutation.receipt);
  useEffect(() => {
    onLocked(locked);
    return () => onLocked(false);
  }, [locked, onLocked]);
  const snapshot = JSON.stringify({
    selected,
    format: format ? learningRef(format) : null,
    instructions,
    output,
    targetSource,
    shared,
  });
  const initial = useRef(snapshot);
  const guard = useDraftNavigation({
    name: mutation.attempted ? "retained Dataset import request" : "Dataset import",
    discardDescription: mutation.attempted
      ? "This import may already be saved. Retry the original request to recover its receipt. Changing the settings starts a separate import; examples already copied remain in workspace review."
      : undefined,
    busy: mutation.busy,
    dirty: !mutation.receipt && (snapshot !== initial.current || mutation.attempted),
  });
  const choices = [...(format ? [format] : []), ...(formats.page?.items ?? [])].filter(
    (item, index, items) =>
      items.findIndex((other) => other.contentHash === item.contentHash) === index,
  );
  function chooseFormat(value: string) {
    const next = choices.find((item) => item.contentHash === value) ?? null;
    if (next) assertLearningContentHash(next);
    setFormat(next);
    setInstructions(next?.instructions ?? source.definition.instructions ?? "");
    const schema = next?.outputSchema ?? source.definition.outputSchema;
    setOutput(schema ? JSON.stringify(schema, null, 2) : "");
  }
  function intent(): Omit<DatasetTrainingReviewRequest, "operationId"> {
    if (!shared) throw new Error("Confirm workspace sharing before copying these examples.");
    if (!selected.length) throw new Error("Select at least one Dataset example.");
    const rewardBindingRef = format?.rewardBinding ?? source.rewardBinding;
    if (!rewardBindingRef) throw new Error("Choose a published task format with a saved Reward.");
    if (!instructions.trim()) throw new Error("Provide the actual task instructions.");
    if (!output.trim()) throw new Error("Provide the actual output schema.");
    const definition = format
      ? {
          name: format.name,
          inputSchema: LearningJsonObjectSchema.parse(format.inputSchema),
          ...(format.requiredOutputs ? { requiredOutputs: format.requiredOutputs } : {}),
        }
      : source.definition;
    return {
      schemaVersion: "openpond.datasetTrainingReviewRequest.v1",
      teamId: api.teamId,
      dataset: source.dataset,
      packageHash: source.packageHash,
      taskIds: [...selected].sort(),
      purpose: method !== "grpo" ? "supervised_training" : "reward_training",
      rewardBindingRef,
      definition: { ...definition, instructions, outputSchema: parseLearningObject(output) },
      targetSource,
      shareWithWorkspace: true,
    };
  }
  const openReview = () => {
    if (mutation.receipt) {
      guard.allowNextNavigation();
      onImported(mutation.receipt);
    }
  };
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void mutation.submit(intent);
      }}
    >
      <ErrorToast error={mutation.error ?? formats.error} />
      {mutation.receipt ? (
        <EvaluationCard title="Imported for review">
          <p role="status">
            {mutation.receipt.evidence.length} examples copied · {mutation.receipt.proposals.length}{" "}
            target proposals.
          </p>
          <p>Grade and review the new evidence before sealing a training batch.</p>
          <button type="button" className="training-button" onClick={openReview}>
            Review imported examples
          </button>
        </EvaluationCard>
      ) : null}
      <EvaluationCard title="Task format">
        <fieldset disabled={locked}>
          <label>
            Task format
            <DropdownSelect
              floating
              searchable
              label="Dataset review task format"
              value={format?.contentHash ?? "dataset"}
              options={[
                {
                  value: "dataset",
                  label: source.rewardBinding
                    ? `${source.definition.name ?? "Dataset"} · Dataset format`
                    : "Choose a task format",
                },
                ...choices.map((item) => ({
                  value: item.contentHash,
                  label: `${item.name} · release ${item.revision}`,
                })),
              ]}
              onChange={chooseFormat}
            />
          </label>
          <LearningPager after={after} next={formats.page?.nextCursor} onPage={setAfter} />
          {!source.rewardBinding && !format ? (
            <p>
              Select a published task format to supply its instructions, output schema and Reward.
              Create one under Import examples if needed.
            </p>
          ) : null}
          {(format?.instructions && format.outputSchema) ||
          (source.definition.instructions && source.definition.outputSchema) ? (
            <details>
              <summary>Instructions and output contract</summary>
              <label>
                Task instructions
                <textarea
                  rows={4}
                  value={instructions}
                  onChange={(event) => setInstructions(event.target.value)}
                />
              </label>
              <LearningJsonField label="Output schema" value={output} onChange={setOutput} />
            </details>
          ) : (
            <>
              <label>
                Task instructions
                <textarea
                  rows={4}
                  value={instructions}
                  onChange={(event) => setInstructions(event.target.value)}
                />
              </label>
              <LearningJsonField label="Output schema" value={output} onChange={setOutput} />
            </>
          )}
          {method !== "grpo" ? (
            <label>
              Target proposals
              <DropdownSelect
                label="Dataset target proposals"
                floating
                value={targetSource}
                onChange={(value) => setTargetSource(value as typeof targetSource)}
                options={[
                  { value: "expected_output", label: "Dataset answers as proposals" },
                  { value: "none", label: "No target proposals" },
                  ...(source.hasParentTargets
                    ? [
                        {
                          value: "approved_parent",
                          label: "Previously approved answers as proposals",
                        },
                      ]
                    : []),
                ]}
              />
            </label>
          ) : null}
          <p>
            Dataset execution requirements and split boundaries are retained. Imported answers still
            need fresh grading and approval.
          </p>
        </fieldset>
      </EvaluationCard>
      <EvaluationCard title="Selected examples">
        <DatasetReviewTaskSelection
          api={api}
          release={source.dataset}
          tasks={tasks}
          selected={selected}
          onChange={setSelected}
          disabled={locked}
        />
      </EvaluationCard>
      <EvaluationCard title="Workspace sharing">
        <label className="learning-inline-choice">
          <input
            type="checkbox"
            checked={shared}
            disabled={locked}
            onChange={(event) => setShared(event.target.checked)}
          />{" "}
          Copy the selected examples into workspace review
        </label>
        <p>
          Workspace members can read the selected inputs, answers and evaluator context. Required
          files are retained for grading and training.
        </p>
      </EvaluationCard>
      {!mutation.receipt ? (
        <div className="model-build-actions">
          <button
            type="submit"
            className="training-button"
            disabled={mutation.busy || !shared || !selected.length}
          >
            {mutation.busy
              ? "Importing…"
              : mutation.attempted
                ? "Retry original import"
                : "Import for review"}
          </button>
          {mutation.attempted ? (
            <button
              type="button"
              className="training-button secondary"
              disabled={mutation.busy}
              onClick={() => void guard.requestLeave(mutation.editSettings)}
            >
              Edit import settings
            </button>
          ) : null}
        </div>
      ) : null}
      {guard.dialog}
    </form>
  );
}
