import { useContext, useMemo, useState } from "react";
import {
  canonicalJson,
  canonicalSha256,
  decisionSourcePreference,
  experimentStartingModelFromDecisionVersion,
  ExperimentDraftSchema,
  type ExperimentStartingModel,
  type TrainingExperimentInputsPage,
  type TrainingPreparationParent,
} from "openpond-sdk/training";
import type { ClientConnection } from "../../api/api-client";
import { useErrorToast } from "../../app/AppToastContext";
import type { useChatContextSelection } from "../../hooks/useChatContextSelection";
import {
  modelSetupTrainingRecipe,
  resourceSetupManagedTrainingMethod,
  type ResourceSetupDraft,
} from "../../lib/resource-setup-prompt";
import { DropdownSelect } from "../DropdownSelect";
import { useTrainingExperimentInputs } from "../labs/workspace/useTrainingExperimentInputs";
import { ReleasedDatasetPicker } from "../labs/workspace/ReleasedDatasetPicker";
import { createWorkspaceApi, type WorkspaceApi } from "../labs/workspace/workspace-api";
import { ChatExperimentWorkspaceContext } from "./ChatExperimentWorkspaceContext";
import { initialDecisionTraining } from "../labs/workspace/decision-form-defaults";
import { ModelSetupDecisionParent, ModelSetupGrpoParent, readModelSetupSavedVersion } from "./ModelSetupSavedStartingVersion";

type ManagedInputs = NonNullable<ResourceSetupDraft["managedTrainingInputs"]>;
type ReviewContext = Pick<ReturnType<typeof useChatContextSelection>, "select" | "selection">;
type Candidate = TrainingExperimentInputsPage["models"][number];

function exactManagedBase(candidate: Candidate) {
  const { source, revision, tokenizerRevision, chatTemplateHash } = candidate.preference;
  return (
    candidate.available &&
    source === "managed" &&
    Boolean(revision && tokenizerRevision && chatTemplateHash)
  );
}

export function ModelSetupManagedReview(props: {
  draft: ResourceSetupDraft;
  connection: ClientConnection | null;
  sessionId: string | null;
  context: ReviewContext;
  field: string;
  busy: boolean;
  onChange(current: ResourceSetupDraft, next: ResourceSetupDraft): void;
  onBusy(busy: boolean): void;
  onOpened(): void;
}) {
  const scope = useContext(ChatExperimentWorkspaceContext);
  const method = resourceSetupManagedTrainingMethod(props.draft);
  const api = useMemo(
    () =>
      props.connection && scope?.actorId && scope.teamId
        ? createWorkspaceApi(props.connection, {
            accountKey: scope.accountKey,
            actorId: scope.actorId,
            teamId: scope.teamId,
            projectId: null,
          })
        : null,
    [props.connection, scope],
  );
  if (!api || !method || !props.sessionId || props.draft.values.destination !== "OpenPond Managed")
    return null;
  return <ManagedFields {...props} api={api} apiOrigin={scope?.apiOrigin} method={method} sessionId={props.sessionId} />;
}

function ManagedFields({
  api,
  apiOrigin,
  draft,
  method,
  sessionId,
  context,
  field,
  busy,
  onChange,
  onBusy,
  onOpened,
}: {
  api: WorkspaceApi;
  draft: ResourceSetupDraft;
  apiOrigin?: string | null;
  method: NonNullable<ReturnType<typeof resourceSetupManagedTrainingMethod>>;
  sessionId: string;
  context: ReviewContext;
  field: string;
  busy: boolean;
  onChange(current: ResourceSetupDraft, next: ResourceSetupDraft): void;
  onBusy(busy: boolean): void;
  onOpened(): void;
}) {
  const [error, setError] = useState<unknown>(null);
  const retained = draft.managedTrainingInputs;
  const matchingScope =
    retained?.accountKey === api.accountKey &&
    retained?.teamId === api.teamId &&
    retained?.actorId === api.actorId && (!retained.apiOrigin || retained.apiOrigin === apiOrigin);
  const decision = method === "decision_model";
  const decisionSource = decision ? decisionSourcePreference() : null;
  const owner = apiOrigin && api.actorId ? { apiOrigin, actorId: api.actorId, teamId: api.teamId } : undefined;
  const retainedBase = matchingScope ? retained.base : undefined;
  const savedStarts = matchingScope && retained.apiOrigin ? retained.savedStarts : undefined;
  const savedStart = method === "sft" ? undefined : savedStarts?.[method];
  const base = savedStart ? { label: savedStart.label, preference: savedStart.base }
    : decisionSource ? { label: decisionSource.modelId, preference: decisionSource } : retainedBase;
  const batch = matchingScope && retained.batch?.method === method ? retained.batch : undefined;
  const validation = matchingScope ? retained.validation : undefined;
  const validationSplit = matchingScope ? (retained.validationSplit ?? "validation") : "validation";
  const picking = !decision && field === "baseModel" || field === "dataset";
  const catalog = useTrainingExperimentInputs(api, picking, batch?.reference);
  const selected = catalog.models.find(
    (candidate) => base && canonicalJson(candidate.preference) === canonicalJson(base.preference),
  );
  const batches = catalog.batches.filter(
    (candidate) =>
      candidate.purpose === (method === "grpo" ? "reward_training" : "supervised_training") &&
      (!decision || Boolean(candidate.sealedAt && candidate.exampleCount)),
  );
  useErrorToast(error ?? (picking ? catalog.error : null));

  function saveInputs(
    update: Pick<ManagedInputs, "base" | "batch" | "validation" | "validationSplit" | "savedStarts">,
    values = draft.values,
    useBatch = false,
  ) {
    onChange(draft, {
      ...draft,
      revision: draft.revision + 1,
      ...(useBatch ? { datasetRef: undefined } : {}),
      values,
      managedTrainingInputs: {
        accountKey: api.accountKey,
        teamId: api.teamId,
        actorId: api.actorId!,
        apiOrigin: apiOrigin ?? undefined,
        savedStarts,
        base: retainedBase,
        batch,
        validation,
        validationSplit,
        ...update,
      },
    });
  }

  async function openReview() {
    if (!base || busy) return;
    onBusy(true);
    setError(null);
    try {
      const name = draft.values.name?.trim() || (decision ? "Decision Model" : method === "sft" ? "Supervised training" : "RL training");
      const budget = draft.values.budget === undefined ? "" : String(draft.values.budget);
      const reviewOwner = decision || savedStart ? owner : undefined;
      if ((decision || savedStart) && !reviewOwner) throw new Error("Choose the workspace that owns this training review.");
      let startingModel: ExperimentStartingModel | undefined;
      let parent: TrainingPreparationParent | undefined;
      if (savedStart) {
        const version = await readModelSetupSavedVersion(api, savedStart);
        if (decision && version.schemaVersion === "openpond.decisionModelVersion.v1" &&
          canonicalJson(base.preference) === canonicalJson(version.baseModel)) {
          startingModel = await experimentStartingModelFromDecisionVersion(version, { ...reviewOwner, label: savedStart.label });
        } else if (method === "grpo" && savedStart.method === "grpo" && version.schemaVersion === "openpond.trainingModelVersion.v1" &&
          version.jobId === savedStart.jobId && version.request.recipe.method === "grpo" &&
          canonicalJson(base.preference) === canonicalJson(version.request.baseModel)) {
          parent = { jobId: version.jobId, checkpointId: version.candidate.checkpointId, artifact: version.candidate.artifact, adapterMode: savedStart.adapterMode };
          startingModel = { source: "trained", label: savedStart.label, baseModel: version.request.baseModel, inferenceModelId: null, trainedVersion: version };
        } else {
          throw new Error("Choose the exact saved starting version for this training method.");
        }
      }
      const savedDecision = startingModel?.source === "decision" ? startingModel.decision : undefined;
      const body = {
        schemaVersion: "openpond.experimentDraft.v1",
        operationType: method,
        name,
        ...(startingModel ? { startingModel } : {}),
        ...(decision ? { decisionForm: {
          mode: "train", baseModel: base.preference, name, maximumSpendUsd: budget,
          parentArtifact: savedDecision?.artifact ?? null, batch: batch?.reference ?? null,
          ...(savedDecision ? { startingDecision: savedDecision } : {}),
          training: draft.decisionTraining ?? initialDecisionTraining(),
        }} : { trainingForm: {
          baseModel: base.preference,
          recipe: modelSetupTrainingRecipe(draft, method, base.preference),
          batch: batch?.reference ?? null,
          evaluation: validation ?? null,
          validationSplit,
          name,
          budget,
          startingModelLabel: base.label,
          ...(parent ? { parent } : {}),
        }}),
      };
      const id = `model-setup-${await canonicalSha256([sessionId, api.accountKey, ...(reviewOwner ? [reviewOwner] : []), body])}`;
      const review = ExperimentDraftSchema.parse({ ...body, id });
      const current = context.selection;
      const reopening = current?.draft?.id === id && (decision ? current.storedDraft : current.localDraft);
      const target = reopening
        ? current.target
        : { kind: "experiment" as const, location: "local" as const, id, draft: review };
      if (await context.select(target, { configureDraft: true, modelTrainingReview: !reopening,
        modelReviewOwner: reopening ? undefined : reviewOwner }))
        onOpened();
    } catch (cause) {
      setError(cause);
    } finally {
      onBusy(false);
    }
  }

  return (
    <div className="resource-setup-fields">
      {field === "baseModel" && (
        decisionSource ? <>
          <p>{base?.preference.modelId}, revision {base?.preference.revision}</p>
          {owner && <ModelSetupDecisionParent key={canonicalJson(owner)} api={api} owner={owner} value={savedStarts?.decision_model}
            disabled={busy} onChange={decision_model => saveInputs({ savedStarts: { ...savedStarts, decision_model } })} />}
        </> : <>
          <DropdownSelect
            label="Managed starting model"
            value={savedStart ? "" : selected?.id ?? (base ? "retained" : "")}
            searchable
            disabled={busy}
            options={[
              { value: "", label: "Choose an exact starting model" },
              ...(base && !savedStart && !selected
                ? [{ value: "retained", label: base.label, disabled: true }]
                : []),
              ...catalog.models.map((candidate) => ({
                value: candidate.id,
                label: candidate.name,
                description: candidate.preference.revision
                  ? `Revision ${candidate.preference.revision.slice(0, 12)}`
                  : "Exact revision unavailable",
                disabled: !exactManagedBase(candidate),
              })),
            ]}
            onChange={(id) => {
              const candidate = catalog.models.find(
                (item) => item.id === id && exactManagedBase(item),
              );
              saveInputs(
                { base: candidate && { label: candidate.name, preference: candidate.preference },
                  ...(method === "grpo" ? { savedStarts: { ...savedStarts, grpo: undefined } } : {}) },
                { ...draft.values, baseModel: candidate?.name },
              );
            }}
          />
          {catalog.isPending && <p role="status">Reading managed starting models…</p>}
          {method === "grpo" && owner && <ModelSetupGrpoParent key={canonicalJson(owner)} api={api} value={savedStarts?.grpo}
            disabled={busy} onChange={grpo => saveInputs({ savedStarts: { ...savedStarts, grpo } })} />}
        </>
      )}
      {field === "dataset" && (
        <>
          <DropdownSelect
            label="Reviewed training batch"
            value={batch?.reference.contentHash ?? ""}
            searchable
            disabled={busy}
            options={[
              { value: "", label: "Choose a reviewed batch in training review" },
              ...batches.map((item) => ({
                value: item.reference.contentHash,
                label: `${item.exampleCount} examples, revision ${item.reference.revision}`,
                description: item.reference.id,
              })),
            ]}
            onChange={(hash) => {
              const item = batches.find((candidate) => candidate.reference.contentHash === hash);
              const batchChoice = item && {
                label: `Reviewed batch, revision ${item.reference.revision}`,
                method,
                reference: item.reference,
              };
              saveInputs(
                { batch: batchChoice },
                {
                  ...draft.values,
                  dataset:
                    batchChoice?.label ?? (draft.datasetRef ? draft.values.dataset : undefined),
                  datasetRevision: item ? undefined : draft.values.datasetRevision,
                },
                Boolean(item),
              );
            }}
          />
          {catalog.hasNextPage && (
            <button
              type="button"
              className="training-text-button"
              disabled={busy || catalog.isFetchingNextPage}
              onClick={() => void catalog.fetchNextPage()}
            >
              More reviewed batches
            </button>
          )}
          {!decision && <><div className="resource-setup-input">
            <span>Validation Dataset</span>
            <ReleasedDatasetPicker
              api={api}
              value={validation ?? null}
              disabled={busy}
              onChange={(value) => saveInputs({ validation: value ?? undefined })}
            />
          </div>
          <DropdownSelect
            label="Optimizer validation split"
            value={validationSplit}
            disabled={busy}
            options={[
              { value: "validation", label: "Validation" },
              { value: "frozen_eval", label: "Frozen evaluation" },
            ]}
            onChange={(value) =>
              saveInputs({
                validationSplit: value === "frozen_eval" ? "frozen_eval" : "validation",
              })
            }
          /></>}
        </>
      )}
      {draft.datasetRef && !batch && (
        <p>Open the review to supply a reviewed batch for managed training.</p>
      )}
      {retained && !matchingScope && (
        <p>Choose starting inputs in this workspace before opening training review.</p>
      )}
      <div>
        <button
          type="button"
          className="training-button secondary"
          disabled={busy || !base || (!decision && !savedStart && selected?.available === false) || (decision && !apiOrigin)}
          onClick={() => void openReview()}
        >
          {decision ? "Save managed draft and open Decision review" : "Open training review"}
        </button>
      </div>
    </div>
  );
}
