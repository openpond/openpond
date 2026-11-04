import { canonicalComputeSpendCap } from "openpond-sdk/training";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  canonicalJson,
  ExperimentDraftSchema,
  type DecisionExperimentFormDraft,
  type ExperimentDraft,
  type ExperimentDraftRecord,
} from "openpond-sdk/training";
import { assertLearningContentHash, learningRef, type TaskBatch } from "openpond-sdk/learning";
import { DropdownSelect } from "../../DropdownSelect";
import { ErrorToast } from "../../common/ErrorToast";
import { DecisionScoringFields, DecisionTrainingFields } from "./DecisionFields";
import { decisionSourcePreference } from "openpond-sdk/training";
import { useDraftNavigation } from "../useDraftNavigation";
import type { DraftNavigationBoundaryHandle } from "../DraftNavigationBoundary";
import { initialDecisionForm } from "./decision-form-defaults";
import { experimentModelSourceKey } from "./experiment-starting-model";
import { experimentDraftApi } from "./experiment-draft-api";
import { useEvaluationSetup } from "./EvaluationSetupState";
import { EvaluationCard } from "./EvaluationPresentation";
import { ExperimentTypeControl } from "./ExperimentTypeControl";
import { useExperimentSetupTransition } from "./useExperimentSetupTransition";
import { useTrainingExperimentInputs } from "./useTrainingExperimentInputs";
import { useManagedDecisionClient } from "./managed-decision-api";
import { useManagedDecisionExperiment } from "./useManagedDecisionExperiment";
import { ManagedDecisionExecution } from "./ManagedDecisionExecution";
import { useTrainingExperimentFunding } from "./useTrainingExperimentFunding";
import { TrainingExperimentFundingSummary } from "./TrainingExperimentFundingSummary";
import { createTrainingFundingHandoff } from "./training-compute-api";
import { WorkspacePanel } from "./WorkspacePanel";
import type { WorkspaceApi } from "./workspace-api";

const ExperimentTrainingDataWorkspace = lazy(() => import("./ExperimentTrainingDataWorkspace"));

/** Decision shares the experiment editor, reviewed data and durable execution owners.
 * Train and score retain their own typed inputs and exact saved adapter source. */
export function DecisionExperimentSetupPanel({
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
  const [form, setForm] = useState<DecisionExperimentFormDraft>(
    () => setup.initialExperiment?.decisionForm ?? initialDecisionForm(),
  );
  const modes = useRef({
    train: initialDecisionForm("train"),
    score: initialDecisionForm("score"),
  });
  const [saving, setSaving] = useState(false),
    [error, setError] = useState<unknown>(null);
  const [dataOpen, setDataOpen] = useState(false);
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
  const owner = useManagedDecisionExperiment(api, {
    draftId: setup.initialExperiment?.id ?? null,
    method: "decision_model",
    visible,
  });
  const inputs = useTrainingExperimentInputs(
    api,
    visible && form.mode === "train",
    form.mode === "train" ? form.batch : null,
  );
  const context = useManagedDecisionClient(api, visible);
  const base = setup.trainingBaseModel ?? form.baseModel;
  const compatibleSource =
    !setup.startingModel ||
    setup.startingModel.source === "managed" ||
    setup.startingModel.source === "decision";
  const sourceKey = experimentModelSourceKey(setup.startingModel);
  const previousSource = useRef(sourceKey);
  useEffect(() => {
    if (previousSource.current !== sourceKey && setup.startingModel?.source !== "decision")
      setForm(({ startingDecision: _source, ...current }) => ({
        ...current,
        parentArtifact: null,
      }));
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
    queryKey: ["decision-execution-capability", scope, query],
    enabled: visible && Boolean(context.data && query),
    retry: false,
    staleTime: 30_000,
    queryFn: ({ signal }) => {
      if (!context.data || !query)
        throw new Error("Choose an exact managed base before checking Decision availability.");
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
    reportDirty("decision_model", dirty);
  }, [dirty, reportDirty]);
  const guard = useDraftNavigation({
    name: "Decision experiment",
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
  function patch(value: { name?: string; maximumSpendUsd?: string }) {
    setForm((current) => ({ ...current, ...value }));
  }
  function draftSnapshot(): ExperimentDraft {
    if (!setup.initialExperiment) throw new Error("Open an experiment before saving its settings.");
    if (!compatibleSource)
      throw new Error("Decision requires its exact managed base. Choose another starting model.");
    return ExperimentDraftSchema.parse({
      schemaVersion: "openpond.experimentDraft.v1",
      id: setup.initialExperiment.id,
      operationType: "decision_model",
      name: form.name.trim() || "Decision experiment",
      ...(setup.startingModel ? { startingModel: setup.startingModel } : {}),
      decisionForm: { ...form, baseModel: base },
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
    setForm((current) =>
      current.mode === "train" ? { ...current, batch: learningRef(batch) } : current,
    );
    setDataOpen(false);
  }
  const batches = inputs.batches.filter(
    (batch) => batch.purpose === "supervised_training" && batch.sealedAt && batch.exampleCount > 0,
  );
  const batch = form.mode === "train" ? form.batch : null;
  const batchValue = batch ? canonicalJson(batch) : "";
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
      label: `${batch!.id} · saved release ${batch!.revision}`,
      disabled: true,
    });
  const modelValue =
    setup.startingModel?.source === "decision"
      ? `decision:${setup.startingModel.decision.versionHash}`
      : setup.startingModel?.source === "trained"
        ? `trained:${setup.startingModel.trainedVersion.contentHash}`
        : setup.startingModel?.source === "engram"
          ? `engram:${setup.startingModel.engram.versionHash}`
          : setup.startingModel?.source === "steering"
            ? `steering:${setup.startingModel.steering.versionHash}`
            : setup.startingModel?.source === "inference"
              ? `inference:${setup.startingModel.inferenceModelId}`
              : base
                ? canonicalJson(base)
                : "";
  const source = decisionSourcePreference();
  const models: Array<{ value: string; label: string; disabled?: boolean }> = [
    { value: canonicalJson(source), label: source.modelId },
  ];
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
          <ErrorToast
            error={
              error ??
              (form.mode === "train" ? inputs.error : null) ??
              capability.error ??
              context.error
            }
          />
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
                    label="Decision starting model"
                    floating
                    searchable
                    value={modelValue}
                    options={models}
                    onChange={(value) => {
                      if (value === modelValue) return;
                      const selected =
                        value === canonicalJson(source) ? { preference: source } : null;
                      if (value && !selected) {
                        setError("Refresh the model list before changing this selection.");
                        return;
                      }
                      setup.setTrainingBaseModel(selected?.preference ?? null);
                      setForm(({ startingDecision: _source, ...current }) => ({
                        ...current,
                        parentArtifact: null,
                      }));
                    }}
                  />
                </label>
                <ExperimentTypeControl disabled={locked} />
                <label>
                  Mode
                  <DropdownSelect
                    floating
                    label="Decision mode"
                    value={form.mode}
                    options={[
                      { value: "train", label: "Train" },
                      { value: "score", label: "Score" },
                    ]}
                    onChange={(mode) => {
                      if (mode === "train" || mode === "score") {
                        modes.current[form.mode] = form;
                        const { startingDecision: _previousSource, ...savedMode } =
                          modes.current[mode];
                        setForm({
                          ...savedMode,
                          baseModel: base,
                          parentArtifact: form.parentArtifact,
                          ...(form.startingDecision
                            ? { startingDecision: form.startingDecision }
                            : {}),
                          name: form.name,
                          maximumSpendUsd: form.maximumSpendUsd,
                        });
                      }
                    }}
                  />
                </label>
                <p>
                  Train from reviewed examples or score unlabeled state against every allowed
                  candidate using this exact Decision adapter.
                </p>
                {form.mode === "train" ? (
                  <button
                    type="button"
                    className="training-text-button"
                    disabled={busy || inputs.isFetching}
                    onClick={() => void inputs.refetch()}
                  >
                    Refresh reviewed batches
                  </button>
                ) : null}
                {available ? (
                  <p>
                    {available.state === "unavailable"
                      ? available.reason
                      : "A compatible Decision runtime is available. Preparation rechecks its exact identity."}
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
            {form.mode === "train" ? (
              <EvaluationCard title="Training data">
                <fieldset disabled={locked}>
                  <label>
                    Reviewed batch
                    <DropdownSelect
                      label="Decision reviewed batch"
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
                        setForm((current) =>
                          current.mode === "train"
                            ? { ...current, batch: selected?.reference ?? null }
                            : current,
                        );
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    className="training-button secondary"
                    onClick={() => setDataOpen(true)}
                  >
                    Import or review data
                  </button>
                </fieldset>
              </EvaluationCard>
            ) : null}
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
                {form.mode === "train" ? (
                  <DecisionTrainingFields form={form} onChange={setForm} />
                ) : (
                  <DecisionScoringFields form={form} onChange={setForm} />
                )}
                {form.startingDecision ? (
                  <p>
                    Saved Model {form.startingDecision.modelProjectId} · version{" "}
                    {form.startingDecision.versionHash}
                  </p>
                ) : null}
                {form.parentArtifact ? (
                  <p>
                    Continue adapter {form.parentArtifact.id} · {form.parentArtifact.contentHash}.
                    Optimizer state starts fresh.
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
                  available?.state !== "ready" ||
                  (form.mode === "train" && (!inputs.isSuccess || !selectedBatch))
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
          <ManagedDecisionExecution
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
            method="decision_model"
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
