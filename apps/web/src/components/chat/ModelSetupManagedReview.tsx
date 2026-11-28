import { useContext, useMemo, useState } from "react";
import {
  canonicalJson,
  canonicalSha256,
  ExperimentDraftSchema,
  type TrainingExperimentInputsPage,
} from "openpond-sdk/training";
import type { ClientConnection } from "../../api/api-client";
import { useErrorToast } from "../../app/AppToastContext";
import type { useChatContextSelection } from "../../hooks/useChatContextSelection";
import {
  modelSetupTrainingRecipe,
  resourceSetupTrainingMethod,
  type ResourceSetupDraft,
} from "../../lib/resource-setup-prompt";
import { DropdownSelect } from "../DropdownSelect";
import { useTrainingExperimentInputs } from "../labs/workspace/useTrainingExperimentInputs";
import { ReleasedDatasetPicker } from "../labs/workspace/ReleasedDatasetPicker";
import { createWorkspaceApi, type WorkspaceApi } from "../labs/workspace/workspace-api";
import { ChatExperimentWorkspaceContext } from "./ChatExperimentWorkspaceContext";

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
  const method = resourceSetupTrainingMethod(props.draft);
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
  return <ManagedFields {...props} api={api} method={method} sessionId={props.sessionId} />;
}

function ManagedFields({
  api,
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
  method: "sft" | "grpo";
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
    retained?.actorId === api.actorId;
  const base = matchingScope ? retained.base : undefined;
  const batch = matchingScope && retained.batch?.method === method ? retained.batch : undefined;
  const validation = matchingScope ? retained.validation : undefined;
  const validationSplit = matchingScope ? (retained.validationSplit ?? "validation") : "validation";
  const picking = field === "baseModel" || field === "dataset";
  const catalog = useTrainingExperimentInputs(api, picking, batch?.reference);
  const selected = catalog.models.find(
    (candidate) => base && canonicalJson(candidate.preference) === canonicalJson(base.preference),
  );
  const batches = catalog.batches.filter(
    (candidate) =>
      candidate.purpose === (method === "sft" ? "supervised_training" : "reward_training"),
  );
  useErrorToast(error ?? (picking ? catalog.error : null));

  function saveInputs(
    update: Pick<ManagedInputs, "base" | "batch" | "validation" | "validationSplit">,
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
        base,
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
      const name =
        draft.values.name?.trim() || (method === "sft" ? "Supervised training" : "RL training");
      const recipe = modelSetupTrainingRecipe(draft, method, base.preference);
      const body = {
        schemaVersion: "openpond.experimentDraft.v1",
        operationType: method,
        name,
        trainingForm: {
          baseModel: base.preference,
          recipe,
          batch: batch?.reference ?? null,
          evaluation: validation ?? null,
          validationSplit,
          name,
          budget: draft.values.budget === undefined ? "" : String(draft.values.budget),
          startingModelLabel: base.label,
        },
      };
      const id = `model-setup-${await canonicalSha256([sessionId, api.accountKey, body])}`;
      const review = ExperimentDraftSchema.parse({ ...body, id });
      const current = context.selection;
      const reopening = current?.draft?.id === id && current.localDraft;
      const target = reopening
        ? current.target
        : { kind: "experiment" as const, location: "local" as const, id, draft: review };
      if (await context.select(target, { configureDraft: true, modelTrainingReview: !reopening }))
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
        <>
          <DropdownSelect
            label="Managed starting model"
            value={selected?.id ?? (base ? "retained" : "")}
            searchable
            disabled={busy}
            options={[
              { value: "", label: "Choose an exact starting model" },
              ...(base && !selected
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
                { base: candidate && { label: candidate.name, preference: candidate.preference } },
                { ...draft.values, baseModel: candidate?.name },
              );
            }}
          />
          {catalog.isPending && <p role="status">Reading managed starting models…</p>}
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
          <div className="resource-setup-input">
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
          />
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
          disabled={busy || !base || selected?.available === false}
          onClick={() => void openReview()}
        >
          Open training review
        </button>
      </div>
    </div>
  );
}
