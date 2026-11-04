import { canonicalComputeSpendCap } from "openpond-sdk/training";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  canonicalJson,
  ExperimentDraftSchema,
  type AlphaEditExperimentFormDraft,
  type ExperimentDraft,
  type ExperimentDraftRecord,
} from "openpond-sdk/training";
import { assertLearningContentHash, learningRef, type TaskBatch } from "openpond-sdk/learning";
import { DropdownSelect } from "../../DropdownSelect";
import { ErrorToast } from "../../common/ErrorToast";
import { AlphaEditFields } from "./AlphaEditFields";
import { useDraftNavigation } from "../useDraftNavigation";
import type { DraftNavigationBoundaryHandle } from "../DraftNavigationBoundary";
import { newAlphaEditExperimentForm } from "openpond-sdk/training";
import { experimentModelSourceKey } from "./experiment-starting-model";
import { experimentDraftApi } from "./experiment-draft-api";
import { useEvaluationSetup } from "./EvaluationSetupState";
import { EvaluationCard } from "./EvaluationPresentation";
import { ExperimentTypeControl } from "./ExperimentTypeControl";
import { useExperimentSetupTransition } from "./useExperimentSetupTransition";
import { useTrainingExperimentInputs } from "./useTrainingExperimentInputs";
import { useManagedAlphaEditClient } from "./managed-alphaedit-api";
import { useManagedAlphaEditExperiment } from "./useManagedAlphaEditExperiment";
import { ManagedAlphaEditExecution } from "./ManagedAlphaEditExecution";
import { useTrainingExperimentFunding } from "./useTrainingExperimentFunding";
import { TrainingExperimentFundingSummary } from "./TrainingExperimentFundingSummary";
import { createTrainingFundingHandoff } from "./training-compute-api";
import { WorkspacePanel } from "./WorkspacePanel";
import type { WorkspaceApi } from "./workspace-api";

const ExperimentTrainingDataWorkspace = lazy(() => import("./ExperimentTrainingDataWorkspace"));

/** AlphaEdit shares the experiment editor and reviewed data owner. Its execution
 * remains a separately typed memory-training request, never an SFT recipe. */
export function AlphaEditExperimentSetupPanel({
  api,
  visible,
  onClose,
  onSaveDraft,
}: {
  api: WorkspaceApi;
  visible: boolean;
  onClose(): void;
  onSaveDraft?: (draft: ExperimentDraft) => Promise<unknown>;
}) {
  const setup = useEvaluationSetup();
  const [form, setForm] = useState<AlphaEditExperimentFormDraft>(
    () =>
      setup.initialExperiment?.alphaEditForm ?? newAlphaEditExperimentForm(setup.trainingBaseModel),
  );
  const [saving, setSaving] = useState(false),
    [error, setError] = useState<unknown>(null);
  const [dataOpen, setDataOpen] = useState(false);
  const [dataSlot, setDataSlot] = useState<"editsBatch" | "preservationBatch">("editsBatch");
  const [billingReturnPending, setBillingReturnPending] = useState(false);
  const billing = useRef<{ record: ExperimentDraftRecord; snapshot: string } | null>(null);
  const checkingBilling = useRef(false);
  const navigation = useRef<DraftNavigationBoundaryHandle>(null);
  const saveActive = useRef(false);
  const scope = canonicalJson([
    api.key,
    api.accountKey,
    api.actorId,
    api.teamId,
    api.projectId,
    api.connection.serverUrl,
    setup.initialExperiment?.id,
  ]);
  const live = useRef(scope);
  live.current = scope;
  useEffect(() => {
    live.current = scope;
    return () => {
      live.current = "";
    };
  }, [scope]);
  function fence() {
    if (live.current !== scope)
      throw new Error("Return to this experiment's original account before continuing.");
  }
  const owner = useManagedAlphaEditExperiment(api, {
    draftId: setup.initialExperiment?.id ?? null,
    method: "alphaedit",
    visible,
  });
  const inputs = useTrainingExperimentInputs(api, visible, form.editsBatch, [
    form.preservationBatch,
  ]);
  const context = useManagedAlphaEditClient(api, visible);
  const base = setup.trainingBaseModel;
  const compatibleSource =
    !setup.startingModel ||
    setup.startingModel.source === "managed" ||
    setup.startingModel.source === "alphaedit";
  const sourceKey = experimentModelSourceKey(setup.startingModel);
  const previousSource = useRef(sourceKey);
  useEffect(() => {
    if (previousSource.current !== sourceKey && setup.startingModel?.source !== "alphaedit")
      setForm(({ startingModule: _source, ...current }) => ({ ...current, parentArtifact: null }));
    previousSource.current = sourceKey;
  }, [sourceKey, setup.startingModel?.source]);
  const query =
    base?.source === "managed" && compatibleSource
      ? {
          teamId: api.teamId,
          source: base.source,
          modelId: base.modelId,
          ...(base.revision ? { revision: base.revision } : {}),
          ...(base.tokenizerRevision ? { tokenizerRevision: base.tokenizerRevision } : {}),
          ...(base.chatTemplateHash ? { chatTemplateHash: base.chatTemplateHash } : {}),
          ...(base.modelAssetId ? { modelAssetId: base.modelAssetId } : {}),
        }
      : null;
  const capability = useQuery({
    queryKey: ["alphaedit-execution-capability", scope, query],
    enabled: visible && Boolean(context.data && query),
    retry: false,
    staleTime: 30_000,
    queryFn: ({ signal }) => {
      if (!context.data || !query)
        throw new Error("Choose an exact managed base before checking AlphaEdit availability.");
      return context.data.capability(query, signal);
    },
    refetchInterval: (state) => (state.state.error ? false : 60_000),
  });
  const available =
    capability.data && !capability.isError && Date.parse(capability.data.expiresAt) > Date.now()
      ? capability.data.execution
      : null;
  const activeExecution =
    owner.selectedId &&
    !["completed", "failed", "cancelled"].includes(
      owner.execution?.phase ?? owner.receipt?.execution.phase ?? "prepared",
    );
  const busy = saving || owner.busy;
  const locked = busy || Boolean(owner.original || activeExecution);
  const snapshot = canonicalJson({ ...form, baseModel: base, sourceKey });
  const latestSnapshot = useRef(snapshot);
  latestSnapshot.current = snapshot;
  const baseline = useRef(snapshot);
  const funding = useTrainingExperimentFunding(api, form.maximumSpendUsd, visible, true);
  const dirty = snapshot !== baseline.current;
  const reportDirty = setup.reportOperationDraftDirty;
  useEffect(() => {
    reportDirty("alphaedit", dirty);
  }, [dirty, reportDirty]);
  const guard = useDraftNavigation({
    name: "AlphaEdit experiment",
    dirty: dirty || setup.operationDraftDirty || setup.evaluationDirty,
    busy,
    onLeave: onClose,
  });
  useExperimentSetupTransition(
    {
      ...guard,
      requestLeave: async (action) => {
        if (dataOpen && navigation.current)
          await navigation.current.requestLeave(() => guard.requestLeave(action));
        else await guard.requestLeave(action);
      },
    },
    visible,
  );
  function patch(value: Partial<AlphaEditExperimentFormDraft>) {
    setForm((current) => ({ ...current, ...value }));
  }
  function draftSnapshot(): ExperimentDraft {
    if (!setup.initialExperiment) throw new Error("Open an experiment before saving its settings.");
    if (!compatibleSource)
      throw new Error("AlphaEdit requires its exact managed base. Choose another starting model.");
    return ExperimentDraftSchema.parse({
      schemaVersion: "openpond.experimentDraft.v1",
      id: setup.initialExperiment.id,
      operationType: "alphaedit",
      name: form.name.trim() || "AlphaEdit experiment",
      ...(setup.startingModel ? { startingModel: setup.startingModel } : {}),
      alphaEditForm: { ...form, baseModel: base },
    });
  }
  async function saveSnapshot(draft: ExperimentDraft) {
    if (!onSaveDraft) throw new Error("Load canonical draft storage before preparing.");
    await onSaveDraft(draft);
    fence();
    const saved = await experimentDraftApi(api).get(draft.id);
    fence();
    if (
      saved.status !== "draft" ||
      saved.projectId !== api.projectId ||
      canonicalJson(saved.draft) !== canonicalJson(draft)
    )
      throw new Error(
        "The saved experiment changed. Reopen its exact current revision before continuing.",
      );
    baseline.current = snapshot;
    return saved;
  }
  async function save() {
    if (saveActive.current || locked) return;
    saveActive.current = true;
    setSaving(true);
    setError(null);
    try {
      await saveSnapshot(draftSnapshot());
    } catch (cause) {
      if (live.current === scope) setError(cause);
    } finally {
      saveActive.current = false;
      if (live.current === scope) setSaving(false);
    }
  }
  async function openBilling() {
    if (saveActive.current || owner.busy || owner.original) return;
    saveActive.current = true;
    setSaving(true);
    setError(null);
    let billingWindow: Window | null = null;
    try {
      const browser = window.openpond?.browser;
      if (!browser?.openExternal) {
        billingWindow = window.open("about:blank", "_blank");
        if (!billingWindow) throw new Error("Allow a new tab to open Billing, then try again.");
        billingWindow.opener = null;
      }
      const record = await saveSnapshot(draftSnapshot());
      fence();
      const cap = canonicalComputeSpendCap(form.maximumSpendUsd);
      const handoff = await createTrainingFundingHandoff(api, {
        schemaVersion: "openpond.trainingFundingHandoffRequest.v1",
        teamId: api.teamId,
        maximumSpendUsd: cap === null ? null : Number(cap),
        draft: {
          id: record.id,
          revision: record.revision,
          contentHash: record.contentHash,
          projectId: record.projectId,
        },
      });
      fence();
      if (!handoff.canPurchase || !handoff.billingUrl)
        throw new Error("A workspace billing owner needs to add credits for this experiment.");
      billing.current = { record, snapshot };
      setBillingReturnPending(true);
      if (browser?.openExternal) {
        const result = await browser.openExternal({
          conversationId: `experiment-funding:${record.id}`,
          url: handoff.billingUrl,
        });
        fence();
        if (!result.ok)
          throw new Error(
            result.error ?? "Billing could not be opened. Your experiment is saved; try again.",
          );
      } else if (billingWindow) {
        billingWindow.location.replace(handoff.billingUrl);
        billingWindow = null;
      }
    } catch (cause) {
      billingWindow?.close();
      if (live.current === scope) {
        setError(cause);
        setBillingReturnPending(false);
        billing.current = null;
      }
    } finally {
      saveActive.current = false;
      if (live.current === scope) setSaving(false);
    }
  }
  async function refreshAfterBilling() {
    if (checkingBilling.current || live.current !== scope) return;
    checkingBilling.current = true;
    try {
      const original = billing.current;
      if (original) {
        const current = await experimentDraftApi(api).get(original.record.id);
        fence();
        if (
          current.contentHash !== original.record.contentHash ||
          current.status !== "draft" ||
          latestSnapshot.current !== original.snapshot
        )
          throw new Error(
            "This experiment changed while Billing was open. Your edits remain here; save and review them before preparing.",
          );
      }
      await funding.refresh();
      fence();
    } catch (cause) {
      if (live.current === scope) setError(cause);
    } finally {
      checkingBilling.current = false;
      if (live.current === scope) {
        billing.current = null;
        setBillingReturnPending(false);
      }
    }
  }
  const refreshBilling = useRef(refreshAfterBilling);
  refreshBilling.current = refreshAfterBilling;
  useEffect(() => {
    if (!billingReturnPending) return;
    const refresh = () => {
      if (document.visibilityState === "visible") void refreshBilling.current();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [billingReturnPending]);
  async function useBatch(batch: TaskBatch) {
    fence();
    if (locked || !visible)
      throw new Error("Return to the editable experiment before selecting data.");
    assertLearningContentHash(batch);
    if (batch.purpose !== "supervised_training" || !batch.sealedAt || !batch.examples.length)
      throw new Error("Choose a sealed, reviewed supervised training batch.");
    patch({ [dataSlot]: learningRef(batch) });
    setDataOpen(false);
  }
  const batches = inputs.batches.filter(
    (batch) => batch.purpose === "supervised_training" && batch.sealedAt && batch.exampleCount > 0,
  );
  const batchValue = form.editsBatch ? canonicalJson(form.editsBatch) : "";
  const selectedBatch = batches.find((batch) => canonicalJson(batch.reference) === batchValue);
  const batchOptions: Array<{ value: string; label: string; disabled?: boolean }> = batches.map(
    (batch) => ({
      value: canonicalJson(batch.reference),
      label: `${batch.reference.id} · release ${batch.reference.revision} · ${batch.exampleCount} examples`,
    }),
  );
  if (batchValue && !batchOptions.some((item) => item.value === batchValue))
    batchOptions.unshift({
      value: batchValue,
      label: `${form.editsBatch!.id} · saved release ${form.editsBatch!.revision}`,
      disabled: true,
    });
  const modelValue =
    setup.startingModel?.source === "trained"
      ? `trained:${setup.startingModel.trainedVersion.contentHash}`
      : setup.startingModel?.source === "alphaedit"
        ? `alphaedit:${setup.startingModel.alphaedit.versionHash}`
        : setup.startingModel?.source === "steering"
          ? `steering:${setup.startingModel.steering.versionHash}`
          : setup.startingModel?.source === "inference"
            ? `inference:${setup.startingModel.inferenceModelId}`
            : base
              ? canonicalJson(base)
              : "";
  const models: Array<{ value: string; label: string; disabled?: boolean }> = inputs.models
    .filter((model) => model.preference.source === "managed")
    .map((model) => ({ value: canonicalJson(model.preference), label: model.name }));
  if (modelValue && !models.some((item) => item.value === modelValue))
    models.unshift({
      value: modelValue,
      label: setup.startingModel?.label ?? base?.modelId ?? "Saved starting model",
      disabled: true,
    });
  return (
    <>
      <div hidden={dataOpen} inert={dataOpen}>
        <WorkspacePanel
          label="Experiment setup"
          action="experiment"
          onRequestClose={() => void guard.requestLeave(onClose)}
        >
          <header>
            <h2>Run Experiment</h2>
            <button type="button" disabled={busy} onClick={() => void guard.requestLeave(onClose)}>
              Close setup
            </button>
          </header>
          <ErrorToast error={error ?? inputs.error ?? capability.error ?? context.error} />
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <EvaluationCard title="Starting model">
              <fieldset disabled={locked}>
                <label>
                  Model
                  <DropdownSelect
                    label="AlphaEdit starting model"
                    floating
                    searchable
                    value={modelValue}
                    options={[{ value: "", label: "Choose exact managed base" }, ...models]}
                    onChange={(value) => {
                      if (value === modelValue) return;
                      const selected = inputs.models.find(
                        (model) =>
                          canonicalJson(model.preference) === value &&
                          model.preference.source === "managed",
                      );
                      if (value && !selected) {
                        setError("Refresh the model list before changing this selection.");
                        return;
                      }
                      setup.setTrainingBaseModel(selected?.preference ?? null);
                      setForm(({ startingModule: _source, ...current }) => ({
                        ...current,
                        parentArtifact: null,
                      }));
                    }}
                  />
                </label>
                <ExperimentTypeControl disabled={locked} />
                <p>
                  AlphaEdit edits factual associations in the exact managed backbone. Preparation
                  resolves reviewed edit and preservation batches and the qualified runtime.
                </p>
                <button
                  type="button"
                  className="training-text-button"
                  disabled={busy || inputs.isFetching}
                  onClick={() => void inputs.refetch()}
                >
                  Refresh models and reviewed batches
                </button>
                {available ? (
                  <p>
                    {available.state === "unavailable"
                      ? available.reason
                      : "A compatible AlphaEdit runtime is available. Preparation rechecks its exact identity."}
                  </p>
                ) : null}
                <button
                  type="button"
                  className="training-text-button"
                  disabled={busy || capability.isFetching || !query}
                  onClick={() => {
                    void context.refetch();
                    void capability.refetch();
                  }}
                >
                  Refresh runtime availability
                </button>
              </fieldset>
            </EvaluationCard>
            <EvaluationCard title="Training data">
              <fieldset disabled={locked}>
                <label>
                  Reviewed edits batch
                  <DropdownSelect
                    label="AlphaEdit reviewed edits"
                    floating
                    searchable
                    value={batchValue}
                    options={[
                      { value: "", label: "Choose sealed supervised batch" },
                      ...batchOptions,
                    ]}
                    onChange={(value) => {
                      const selected = batches.find(
                        (batch) => canonicalJson(batch.reference) === value,
                      );
                      if (value && !selected) {
                        setError("Refresh the reviewed batch before changing this selection.");
                        return;
                      }
                      patch({ editsBatch: selected?.reference ?? null });
                    }}
                  />
                </label>
                <button
                  type="button"
                  className="training-button secondary"
                  onClick={() => {
                    setDataSlot("editsBatch");
                    setDataOpen(true);
                  }}
                >
                  Import or review edits
                </button>
              </fieldset>
            </EvaluationCard>
            <EvaluationCard title="Preservation data">
              <fieldset disabled={locked}>
                <label>
                  Preservation batch
                  <DropdownSelect
                    label="AlphaEdit preservation batch"
                    floating
                    searchable
                    value={form.preservationBatch ? canonicalJson(form.preservationBatch) : ""}
                    options={[
                      { value: "", label: "Choose reviewed preservation batch" },
                      ...batchOptions,
                    ]}
                    onChange={(value) => {
                      const selected = batches.find(
                        (batch) => canonicalJson(batch.reference) === value,
                      );
                      if (value && !selected) {
                        setError("Refresh this exact preservation release before choosing it.");
                        return;
                      }
                      patch({ preservationBatch: selected?.reference ?? null });
                    }}
                  />
                </label>
                <button
                  type="button"
                  className="training-button secondary"
                  onClick={() => {
                    setDataSlot("preservationBatch");
                    setDataOpen(true);
                  }}
                >
                  Import or review preservation data
                </button>
                <p>
                  Edit input contains subject and promptTemplate. Its reviewed expected output
                  is an object with a text field containing the literal target. Preservation
                  input contains text; its expected output has the same text field and literal value.
                </p>
              </fieldset>
            </EvaluationCard>
            <EvaluationCard title="Settings">
              <fieldset disabled={locked}>
                <label>
                  Experiment name
                  <input
                    value={form.name}
                    maxLength={500}
                    onChange={(event) => patch({ name: event.target.value })}
                  />
                </label>
                <AlphaEditFields form={form} onChange={setForm} />
                {form.startingModule ? (
                  <p>
                    Saved Model {form.startingModule.modelProjectId} · version{" "}
                    {form.startingModule.versionHash}
                  </p>
                ) : null}
                {form.parentArtifact ? (
                  <p>
                    Continue exact matrices and sequential state {form.parentArtifact.id} ·{" "}
                    {form.parentArtifact.contentHash}.
                  </p>
                ) : null}
                <label>
                  Spending limit (USD, optional)
                  <input
                    type="text"
                    inputMode="decimal"
                    maxLength={100}
                    placeholder="Use available credits" value={form.maximumSpendUsd}
                    onChange={(event) => patch({ maximumSpendUsd: event.target.value })}
                  />
                </label>
              </fieldset>
            </EvaluationCard>
            <TrainingExperimentFundingSummary
              funding={funding}
              busy={busy}
              startAttempted={Boolean(owner.original)}
              billingReturnPending={billingReturnPending}
              onOpenBilling={onSaveDraft ? openBilling : null}
              onRefresh={refreshAfterBilling}
            />
            <div className="model-build-actions">
              <button
                type="submit"
                className="training-button secondary"
                disabled={locked || !onSaveDraft}
              >
                {saving ? "Saving…" : "Save draft"}
              </button>
              <button
                type="button"
                className="training-button"
                disabled={
                  locked ||
                  billingReturnPending ||
                  !onSaveDraft ||
                  !owner.ready ||
                  !inputs.isSuccess ||
                  available?.state !== "ready" ||
                  !selectedBatch ||
                  !form.preservationBatch
                }
                onClick={() => {
                  setError(null);
                  try {
                    void owner.prepare(draftSnapshot(), saveSnapshot);
                  } catch (cause) {
                    setError(cause);
                  }
                }}
              >
                Compile and prepare
              </button>
            </div>
          </form>
          <ManagedAlphaEditExecution
            owner={owner}
            api={api}
            disabled={busy}
            onOpenBilling={onSaveDraft ? openBilling : null}
            billingReturnPending={billingReturnPending}
            onRefreshFunding={refreshAfterBilling}
          />
          {guard.dialog}
        </WorkspacePanel>
      </div>
      {dataOpen ? (
        <Suspense fallback={<p role="status">Opening training data…</p>}>
          <ExperimentTrainingDataWorkspace
            api={api}
            method="alphaedit"
            navigation={navigation}
            onClose={() => setDataOpen(false)}
            onUseBatch={useBatch}
            beforeImport={async () => {
              fence();
              if (locked) throw new Error("Finish the original operation before importing data.");
              await saveSnapshot(draftSnapshot());
              fence();
            }}
          />
        </Suspense>
      ) : null}
    </>
  );
}
