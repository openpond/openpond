import { useEffect, useRef, useState } from "react";
import { createModelTrainingRecipeDefaults } from "openpond-sdk/model-starters";
import {
  canonicalJson,
  canonicalComputeSpendCap,
  ExperimentDraftSchema,
  parseAndVerifyExperimentDraft,
  TrainingExperimentFormDraftSchema,
  TrainingExperimentSetupRequestSchema,
  parseAndVerifyTrainingExperimentSetupReceipt,
  parseAndVerifyTrainingPreparationReceipt,
  type TrainingExperimentSetupRequest,
  type TrainingPreparationReceipt,
  type ExperimentDraft,
  type TrainingGpuSelection,
  type ExperimentDraftRecord,
} from "openpond-sdk/training";
import {
  TrainingExperimentRecoveryIntentSchema,
  TrainingExperimentControlIntentSchema,
} from "@openpond/contracts";
import {
  useTrainingExperimentRecovery,
  TRAINING_PREPARATION_ACTION,
  TRAINING_CONTROL_ACTION,
  type RetainedTrainingReview,
  type RetainedTrainingControl,
} from "./useTrainingExperimentRecovery";
import { modelTrainingSettingsProblem } from "../ModelTrainingSettings";
import { useAppToast } from "../../../app/AppToastContext";
import { isConnectionErrorMessage } from "../../../lib/error-messages";
import { useDraftNavigation } from "../useDraftNavigation";
import { apiFetch, ApiRequestError } from "../../../api/api-client";
import { useEvaluationSetup } from "./EvaluationSetupState";
import { reconcileChangedTrainingPreparation } from "./training-preparation-recovery";
import { useTrainingExperimentInputs } from "./useTrainingExperimentInputs";
import type { WorkspaceApi } from "./workspace-api";
import { modelsRouteFromLocation } from "../models-route";
import { useTrainingExperimentCompute } from "./useTrainingExperimentCompute";
import { useTrainingExperimentFunding } from "./useTrainingExperimentFunding";
import { createTrainingFundingHandoff } from "./training-compute-api";
import { experimentDraftApi } from "./experiment-draft-api";
import { connectionQueryScope } from "../../../lib/query-scope";

type Ref = TrainingExperimentSetupRequest["batch"];
export function useTrainingExperimentForm(
  api: WorkspaceApi,
  method: "sft" | "grpo",
  visible: boolean,
  onClose: () => void,
  onStarted: (id: string) => void | Promise<void>,
  onSaveDraft?: (draft: ExperimentDraft) => Promise<unknown>,
) {
  const setup = useEvaluationSetup();
  const showToast = useAppToast();
  const seed =
    setup.initialExperiment?.operationType === method
      ? setup.initialExperiment
      : null;
  const seedDataset = seed?.training?.settings?.recipe?.dataset;
  const savedValidationSplit =
    seedDataset &&
    typeof seedDataset === "object" &&
    "validationSplit" in seedDataset &&
    seedDataset.validationSplit === "frozen_eval"
      ? "frozen_eval"
      : "validation";
  const [recipe, setRecipe] = useState(
    () =>
      seed?.trainingForm?.recipe ??
      seed?.training?.settings?.recipe ??
      createModelTrainingRecipeDefaults(null, method, setup.trainingBaseModel),
  );
  const [batch, setBatch] = useState<Ref | null>(
    seed?.trainingForm
      ? seed.trainingForm.batch
      : (seed?.training?.batch ?? null),
  );
  const inputs = useTrainingExperimentInputs(api, visible, batch);
  const [evaluation, setEvaluation] = useState<Ref | null>(
    seed?.trainingForm
      ? seed.trainingForm.evaluation
      : (seed?.training?.settings?.evaluationTasksetRef ??
          setup.draft?.release ??
          null),
  );
  const [validationSplit, setValidationSplit] = useState<
    "validation" | "frozen_eval"
  >(seed?.trainingForm?.validationSplit ?? savedValidationSplit);
  const [name, setName] = useState(
    seed?.trainingForm?.name ??
      seed?.name ??
      (method === "sft" ? "Supervised training" : "RL training"),
  );
  const [startingModelLabel, setStartingModelLabel] = useState(
    seed?.trainingForm?.startingModelLabel,
  );
  const [budget, setBudget] = useState(
    seed?.trainingForm?.budget ?? String(seed?.training?.maximumSpendUsd ?? 1),
  );
  const [customerCapUsd, setCustomerCapUsd] = useState(
    seed?.trainingForm?.customerCapUsd ?? seed?.training?.usageFunding?.customerCapUsd ?? "",
  );
  const [selectedBillingMode, setBillingMode] = useState<"prepaid_only" | "actual_usage" | null>(
    seed?.trainingForm?.billingMode ?? (seed?.training ? seed.training.usageFunding ? "actual_usage" : "prepaid_only" : null),
  );
  const billingMode = selectedBillingMode ?? (inputs.billingModes?.[1].availability === "requires_preparation" ? "actual_usage" : "prepaid_only");
  const [gpuSelection, setGpuSelection] = useState<TrainingGpuSelection>(
    seed?.trainingForm?.gpuSelection ??
      seed?.training?.settings?.managedGpuSelection ?? {
        mode: "automatic",
        objective: "balanced",
        gpuCount: 1,
      },
  );
  const [recoveredJobId, setRecoveredJobId] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<TrainingPreparationReceipt | null>(
    null,
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null);
  const active = useRef(false);
  const pending = useRef<RetainedTrainingReview | null>(null);
  const pendingControl = useRef<RetainedTrainingControl | null>(null);
  const recovery = useTrainingExperimentRecovery(
    api,
    setup.initialExperiment?.id,
    method,
    visible,
  );
  const [startAttempted, setStartAttempted] = useState(false);
  const compute = useTrainingExperimentCompute({
    api,
    method,
    enabled: visible,
    baseModel: setup.trainingBaseModel,
    recipe,
    selection: gpuSelection,
    receipt,
  });
  const funding = useTrainingExperimentFunding(api, receipt?.plan.usageQuote ? receipt.plan.usageQuote.customerCapUsd ?? ""
    : receipt ? String(receipt.plan.request.maximumSpendUsd) : billingMode === "actual_usage" ? customerCapUsd : budget, visible,
    receipt ? Boolean(receipt.plan.usageQuote) : billingMode === "actual_usage");
  const billingDraft = useRef<ExperimentDraftRecord | null>(null);
  const [billingReturnPending, setBillingReturnPending] = useState(false);
  const scope = JSON.stringify([
    api.key,
    api.connection.serverUrl,
    api.actorId,
    setup.initialExperiment?.id,
    connectionQueryScope(api.connection),
  ]);
  const activeScope = useRef(scope);
  activeScope.current = scope;
  useEffect(() => {
    activeScope.current = scope;
    return () => {
      activeScope.current = "unmounted";
    };
  }, [scope]);
  const formSnapshot = {
    startingModel: setup.startingModel,
    baseModel: setup.trainingBaseModel,
    ...(setup.trainingParent
      ? { parent: setup.trainingParent, startingModelLabel }
      : {}),
    recipe,
    batch,
    evaluation,
    validationSplit,
    name,
    budget,
    customerCapUsd,
    billingMode,
    gpuSelection,
  };
  const snapshot = canonicalJson(formSnapshot);
  const initialSnapshot = useRef(snapshot);
  const dirty = snapshot !== initialSnapshot.current || receipt !== null;
  const reportDirty = setup.reportOperationDraftDirty;
  useEffect(() => {
    reportDirty(method, dirty);
  }, [method, dirty, reportDirty]);
  const guard = useDraftNavigation({
    name: "training experiment",
    dirty: dirty || setup.operationDraftDirty || setup.evaluationDirty,
    busy,
    onLeave: onClose,
    retainForDestination(destination) {
      const route = modelsRouteFromLocation(
        new URL(destination, window.location.origin),
      );
      return Boolean(
        route &&
        ["datasets", "graders", "experiments"].includes(route.page) &&
        (route.collection !== "drafts" ||
          route.resourceId === setup.initialExperiment?.id) &&
        (route.projectId ?? null) === api.projectId,
      );
    },
  });
  const selectedBatch = inputs.batches.find(
    (item) =>
      batch !== null &&
      item.reference.id === batch.id &&
      item.reference.revision === batch.revision &&
      item.reference.contentHash === batch.contentHash,
  );
  const locked = busy || receipt !== null;
  function currentDraft() {
    if (!setup.initialExperiment)
      throw new Error("Open an experiment before saving.");
    const trainingForm = TrainingExperimentFormDraftSchema.parse({
      baseModel: setup.trainingBaseModel,
      recipe,
      batch,
      evaluation,
      validationSplit,
      name,
      budget,
      customerCapUsd,
      billingMode,
      gpuSelection,
      ...(setup.trainingParent
        ? { parent: setup.trainingParent, startingModelLabel }
        : {}),
    });
    return ExperimentDraftSchema.parse({
      schemaVersion: "openpond.experimentDraft.v1",
      id: setup.initialExperiment.id,
      operationType: method,
      name:
        name.trim() ||
        (method === "sft" ? "Supervised training" : "RL training"),
      trainingForm,
      ...(setup.startingModel ? {startingModel: setup.startingModel} : {}),
    });
  }
  function fence() {
    if (activeScope.current !== scope)
      throw new Error("The active account changed. Reopen this experiment.");
  }
  async function persistDraft() {
    if (!onSaveDraft)
      throw new Error("Save this experiment before opening Billing.");
    const draft = currentDraft();
    await onSaveDraft(draft);
    fence();
    // Both the ordinary page and chat save to this owner. Do not rely on their
    // different callback return shapes or an old successful save receipt.
    const record = await experimentDraftApi(api).get(draft.id);
    fence();
    if (
      record.status !== "draft" ||
      canonicalJson(record.draft) !== canonicalJson(draft)
    )
      throw new Error(
        "The saved experiment changed. Your edits remain here; reopen the current draft before continuing.",
      );
    initialSnapshot.current = snapshot;
    return record;
  }
  async function saveDraft() {
    if (!onSaveDraft || !setup.initialExperiment || active.current || receipt)
      return false;
    active.current = true;
    setBusy(true);
    setError(null);
    try {
      await persistDraft();
      return true;
    } catch (cause) {
      if (activeScope.current === scope) setError(cause);
      return false;
    } finally {
      active.current = false;
      if (activeScope.current === scope) setBusy(false);
    }
  }
  async function openBilling() {
    if (
      active.current ||
      startAttempted ||
      (receipt && receipt.state !== "prepared")
    )
      return;
    active.current = true;
    setBusy(true);
    setError(null);
    let billingWindow: Window | null = null;
    try {
      const browser = window.openpond?.browser;
      if (!browser?.openExternal) {
        // Keep the browser's user gesture while the exact draft is saved. The
        // detached tab receives only the validated grantless Billing URL.
        billingWindow = window.open("about:blank", "_blank");
        if (!billingWindow)
          throw new Error("Allow a new tab to open Billing, then try again.");
        billingWindow.opener = null;
      }
      const record = await persistDraft();
      const usageCap = funding.allocationAdmission ? canonicalComputeSpendCap(customerCapUsd) : null;
      const handoff = await createTrainingFundingHandoff(api, {
        schemaVersion: "openpond.trainingFundingHandoffRequest.v1",
        teamId: api.teamId,
        maximumSpendUsd: funding.allocationAdmission ? usageCap === null ? null : Number(usageCap) : Number(budget),
        draft: {
          id: record.id,
          revision: record.revision,
          contentHash: record.contentHash,
          projectId: record.projectId,
        },
      });
      fence();
      if (!handoff.canPurchase || !handoff.billingUrl)
        throw new Error(
          "A workspace billing owner needs to add credits for this experiment.",
        );
      billingDraft.current = record;
      setBillingReturnPending(true);
      compute.requireFreshReview();
      if (browser?.openExternal) {
        const result = await browser.openExternal({
          conversationId: `experiment-funding:${record.id}`,
          url: handoff.billingUrl,
        });
        fence();
        if (!result.ok)
          throw new Error(
            result.error ??
              "Billing could not be opened. Your experiment is saved; try again.",
          );
      } else if (billingWindow) {
        billingWindow.location.replace(handoff.billingUrl);
        billingWindow = null;
      }
    } catch (cause) {
      billingWindow?.close();
      if (activeScope.current === scope) setError(cause);
    } finally {
      active.current = false;
      if (activeScope.current === scope) setBusy(false);
    }
  }
  async function refreshCredits() {
    if (active.current || startAttempted) return;
    active.current = true;
    setBusy(true);
    setError(null);
    try {
      if (billingDraft.current) {
        const retained = billingDraft.current;
        const current = await experimentDraftApi(api).get(retained.id);
        fence();
        if (
          current.status !== "draft" ||
          current.contentHash !== retained.contentHash ||
          current.revision !== retained.revision
        )
          throw new Error(
            "This experiment changed while Billing was open. Your edits remain here; reopen the saved draft before running.",
          );
      }
      const credits = funding.allocationAdmission ? null : await funding.query.refetch();
      fence();
      if (credits?.error) throw credits.error;
      if (receipt?.state === "prepared") {
        const estimate = await compute.estimate.refetch();
        fence();
        if (estimate.error) throw estimate.error;
      }
      if (funding.allocationAdmission || credits?.data?.state === "covered") {
        billingDraft.current = null;
        setBillingReturnPending(false);
      }
    } catch (cause) {
      if (activeScope.current === scope) setError(cause);
    } finally {
      active.current = false;
      if (activeScope.current === scope) setBusy(false);
    }
  }
  const refreshOnReturn = useRef(refreshCredits);
  refreshOnReturn.current = refreshCredits;
  useEffect(() => {
    if (!visible) return;
    const returned = () => {
      if (billingDraft.current && document.visibilityState === "visible")
        void refreshOnReturn.current();
    };
    window.addEventListener("focus", returned);
    document.addEventListener("visibilitychange", returned);
    return () => {
      window.removeEventListener("focus", returned);
      document.removeEventListener("visibilitychange", returned);
    };
  }, [scope, visible]);
  async function perform(
    action: "prepare" | "start" | "cancel" | "recover",
    options?: { newRun: boolean },
  ) {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError(null);
    const fence = () => {
      if (activeScope.current !== scope)
        throw new Error("The active account changed. Reopen this experiment.");
    };
    async function request(command: string, body: unknown) {
      fence();
      const value = await apiFetch(
        api.connection,
        `/v1/training/setup/${command}?teamId=${encodeURIComponent(api.teamId)}`,
        { method: "POST", body: JSON.stringify(body) },
      );
      fence();
      return value;
    }
    let controlDispatched = false;
    try {
      fence();
      if (!recovery.isSuccess)
        throw new Error("Load retained training reviews before continuing.");
      // Another window or a lost device-journal reply may have retained the
      // command since this form loaded. Read it before considering new approval.
      const refreshed = await recovery.refetch();
      fence();
      if (refreshed.error || !refreshed.data)
        throw (
          refreshed.error ??
          new Error("Load retained training reviews before continuing.")
        );
      const recovered = refreshed.data;
      if (
        pending.current?.request.operationId ===
        recovered.review?.request.operationId
      )
        pendingControl.current ??= recovered.control;
      if (action === "recover") {
        const retained = pending.current ?? recovered.review;
        if (!retained)
          throw new Error(
            "No previous training review is retained for this experiment.",
          );
        pending.current = retained;
        pendingControl.current ??= recovered.control;
        await retained.operation.retainCommand(retained.request, "dispatching");
        fence();
        const wrapper = await parseAndVerifyTrainingExperimentSetupReceipt(
          await request("prepare-draft", retained.request),
        );
        if (
          canonicalJson(wrapper.request) !== canonicalJson(retained.request) ||
          wrapper.preparation.plan.creatorUserId !== api.actorId
        )
          throw new Error(
            "The recovered training review differs from its retained request or creator.",
          );
        const current = wrapper.preparation,
          control = pendingControl.current;
        if (
          control &&
          (current.plan.id !== control.command.id ||
            current.plan.contentHash !== control.command.control.planHash ||
            (current.state === "prepared" &&
              current.revision !== control.command.control.expectedRevision))
        )
          throw new Error(
            "The original training control does not own this current preparation.",
          );
        const form = retained.intent.form;
        setup.setTrainingBaseModel(form.baseModel);
        setup.setTrainingParent(form.parent ?? null);
        setStartingModelLabel(form.startingModelLabel);
        setRecipe(form.recipe);
        setBatch(form.batch);
        setEvaluation(form.evaluation);
        setValidationSplit(form.validationSplit);
        setName(form.name);
        setBudget(form.budget);
        setCustomerCapUsd(form.customerCapUsd ?? current.plan.request.usageFunding?.customerCapUsd ?? "");
        setBillingMode(current.plan.request.usageFunding ? "actual_usage" : "prepaid_only");
        setGpuSelection(
          form.gpuSelection ?? {
            mode: "automatic",
            objective: "balanced",
            gpuCount: 1,
          },
        );
        setReceipt(current);
        setStartAttempted(Boolean(control?.command.action === "start"));
        if (current.state !== "prepared") {
          await control?.operation.acknowledge();
          await retained.acknowledge();
          fence();
          pendingControl.current = null;
          pending.current = null;
          setStartAttempted(false);
          if (current.state === "submitted") setRecoveredJobId(current.jobId);
          else setReceipt(null);
          await recovery.refetch();
        }
        return;
      }
      if (!pending.current && recovered.review)
        throw new Error(
          "Restore the previous training review before preparing or starting another request.",
        );
      if (
        pendingControl.current &&
        pendingControl.current.command.action !== action
      )
        throw new Error(
          "Recover the original training control before changing its action.",
        );
      if (action === "prepare") {
        if (recoveredJobId && !options?.newRun)
          throw new Error(
            "The earlier preparation already started. Your edited settings remain here. Open the existing run or review these edits for a new run.",
          );
        if (options?.newRun) setRecoveredJobId(null);
        if (pending.current && pending.current.snapshot !== snapshot) {
          const recovered = await reconcileChangedTrainingPreparation({
            retained: pending.current,
            snapshot,
            request,
          });
          fence();
          if (recovered.kind !== "unchanged") pending.current = null;
          if (recovered.kind === "submitted") {
            setRecoveredJobId(recovered.jobId);
            throw new Error(
              "The earlier preparation already started. Your edited settings remain here. Open the existing run or review these edits for a new run.",
            );
          }
        }
        if (pending.current?.snapshot !== snapshot) {
          if (!api.actorId || !inputs.isSuccess)
            throw new Error(
              "Load the current training inputs before reviewing this experiment.",
            );
          if (setup.startingModel?.source === "steering" || setup.startingModel?.source === "engram")
            throw new Error("Training cannot consume this saved steering source. Choose another starting model instead of substituting its base.");
          if (setup.startingModel?.source === "trained") {
            await parseAndVerifyExperimentDraft(currentDraft(), {teamId: api.teamId});
            const version = setup.startingModel.trainedVersion, parent = setup.trainingParent;
            if (method !== "grpo" || !parent || parent.jobId !== version.jobId ||
                parent.checkpointId !== version.candidate.checkpointId || canonicalJson(parent.artifact) !== canonicalJson(version.candidate.artifact))
              throw new Error("This trained source requires its exact qualified GRPO parent. Choose another starting model for this method.");
          }
          if (setup.trainingParent && method !== "grpo")
            throw new Error("Checkpoint continuation currently requires GRPO.");
          if (!inputs.methods.includes(method))
            throw new Error(
              "This account has no available execution for the selected training method.",
            );
          const base = setup.trainingBaseModel;
          if (
            !base ||
            !inputs.models.some(
              (item) =>
                item.available &&
                canonicalJson(item.preference) === canonicalJson(base),
            )
          )
            throw new Error("Choose an available pinned starting model.");
          if (
            !selectedBatch ||
            selectedBatch.purpose !==
              (method === "sft" ? "supervised_training" : "reward_training")
          )
            throw new Error(
              "Choose a reviewed batch matching this training method.",
            );
          if (!evaluation)
            throw new Error("Choose the exact validation Dataset version.");
          if (!name.trim())
            throw new Error("Enter a name for this experiment.");
          const maximumSpendUsd = Number(budget);
          if (
            !Number.isFinite(maximumSpendUsd) ||
            maximumSpendUsd <= 0 ||
            maximumSpendUsd > 1_000_000
          )
            throw new Error("Enter a positive planning budget up to $1,000,000.");
          if (billingMode === "actual_usage" && inputs.billingModes?.[1].availability !== "requires_preparation")
            throw new Error("Actual-usage training is not qualified for this runtime. Select the available billing mode before preparing a new run.");
          const usageFunding = billingMode === "actual_usage" ? {
            schemaVersion: "openpond.trainingUsageFundingRequest.v1" as const,
            billingMode: "actual_usage" as const,
            customerCapUsd: canonicalComputeSpendCap(customerCapUsd),
          } : undefined;
          const dataset =
            recipe.dataset && typeof recipe.dataset === "object"
              ? (recipe.dataset as Record<string, unknown>)
              : {};
          const examples = dataset.maxExamples;
          if (
            typeof examples !== "number" ||
            !Number.isInteger(examples) ||
            examples < 1 ||
            examples > selectedBatch.exampleCount ||
            (method === "sft" && examples > 1000)
          )
            throw new Error(
              "Choose a valid training example count within the reviewed batch and runtime limits.",
            );
          const problem = modelTrainingSettingsProblem(recipe);
          if (problem) throw new Error(problem);
          if (
            !compute.catalog.data ||
            compute.catalogExpired ||
            compute.catalog.isFetching ||
            compute.catalog.isError
          )
            throw new Error(
              "Refresh compute availability before reviewing this experiment.",
            );
          if (
            !compute.catalog.data.offerings.length ||
            compute.catalog.data.scope?.qualification !== "requires_preparation"
          )
            throw new Error(
              "No qualified compute is currently available for this model and training setup.",
            );
          if (
            gpuSelection.mode === "manual" &&
            !compute.catalog.data.offerings.some(
              (offer) =>
                offer.availabilityId === gpuSelection.availabilityId &&
                offer.gpuType === gpuSelection.gpuType,
            )
          )
            throw new Error(
              "The selected GPU offering is unavailable. Refresh availability or choose another offering.",
            );
          const intent = {
            teamId: api.teamId,
            projectId: api.projectId,
            baseModel: base,
            ...(setup.trainingParent ? { parent: setup.trainingParent } : {}),
            batch: selectedBatch.reference,
            name: name.trim(),
            maximumSpendUsd,
            ...(usageFunding ? { usageFunding } : {}),
            gpuSelection,
            settings: {
              method,
              recipe: {
                ...recipe,
                dataset: {
                  ...(recipe.dataset && typeof recipe.dataset === "object"
                    ? recipe.dataset
                    : {}),
                  validationSplit,
                },
              },
              evaluationTasksetRef: evaluation,
              rewardBindingRef: selectedBatch.rewardBinding,
              managedRolloutPlacement: "remote" as const,
            },
          };
          const reviewedIntent = TrainingExperimentRecoveryIntentSchema.parse({
            draftId: setup.initialExperiment?.id,
            form: TrainingExperimentFormDraftSchema.parse(formSnapshot),
            request: {
              ...intent,
              schemaVersion: "openpond.trainingExperimentSetupRequest.v1",
            },
          });
          const retained = await api.operation(
            TRAINING_PREPARATION_ACTION,
            reviewedIntent,
          );
          fence();
          const reviewed = TrainingExperimentSetupRequestSchema.parse({
            ...reviewedIntent.request,
            operationId: retained.id,
          });
          pending.current = {
            snapshot,
            intent: reviewedIntent,
            request: reviewed,
            operation: retained,
            acknowledge: retained.acknowledge,
          };
        }
        // Reconcile the exact retained request before consulting changed catalogs.
        const retained = pending.current!;
        await retained.operation.retainCommand(retained.request, "dispatching");
        fence();
        const reviewed = retained.request;
        const value = await parseAndVerifyTrainingExperimentSetupReceipt(
          await request("prepare-draft", reviewed),
        );
        if (
          canonicalJson(value.request) !== canonicalJson(reviewed) ||
          value.preparation.plan.creatorUserId !== api.actorId
        )
          throw new Error("The service prepared a different experiment draft.");
        setReceipt(value.preparation);
        pendingControl.current = null;
        setStartAttempted(false);
      } else {
        if (!receipt)
          throw new Error("Review this experiment before starting it.");
        if (receipt.state === "submitted" && receipt.jobId) {
          guard.allowNextNavigation();
          await onStarted(receipt.jobId);
          return;
        }
        if (!pending.current)
          throw new Error(
            "Recover the original preparation before submitting a control.",
          );
        if (!pendingControl.current) {
          let estimateReview;
          if (action === "start") {
            if (billingReturnPending)
              throw new Error(
                "Return from Billing and refresh credits before starting.",
              );
            funding.assertCovered();
            estimateReview = compute.reviewedEstimate();
          }
          const intent = TrainingExperimentControlIntentSchema.parse({
            draftId: setup.initialExperiment?.id,
            method,
            preparationOperationId: pending.current.request.operationId,
            receipt,
            command: {
              action,
              id: receipt.plan.id,
              control: {
                teamId: api.teamId,
                planHash: receipt.plan.contentHash,
                expectedRevision: receipt.revision,
                ...(receipt.plan.usageQuote ? { usageQuoteHash: receipt.plan.usageQuote.contentHash } : {}),
                ...(estimateReview ? { estimateReview } : {}),
              },
            },
          });
          const operation = await api.operation(
            TRAINING_CONTROL_ACTION,
            intent,
          );
          fence();
          pendingControl.current = {
            intent,
            command: intent.command,
            operation,
            phase: "reviewed",
          };
        }
        const control = pendingControl.current;
        if (action === "start") setStartAttempted(true);
        await control.operation.retainCommand(control.command, "dispatching");
        fence();
        control.phase = "dispatching";
        const { action: command, ...body } = control.command;
        controlDispatched = true;
        const value = await parseAndVerifyTrainingPreparationReceipt(
          await request(command, body),
        );
        if (
          value.plan.contentHash !== receipt.plan.contentHash ||
          value.plan.request.teamId !== api.teamId
        )
          throw new Error("Training control returned a different preparation.");
        setReceipt(value);
        setStartAttempted(false);
        if (action === "start" && value.state === "submitted" && value.jobId) {
          const id = value.jobId;
          // The Job already exists even if acknowledgement fails. Open that Job;
          // never present attachment/recovery failure as a new paid submission.
          try {
            await control.operation.acknowledge();
            await pending.current?.acknowledge();
          } catch (cause) {
            if (
              !isConnectionErrorMessage(
                cause instanceof Error ? cause.message : String(cause),
              )
            )
              showToast?.(
                "Training started. Desktop recovery acknowledgement is still pending.",
                "error",
                { dedupeKey: `training-ack:${id}` },
              );
          }
          fence();
          guard.allowNextNavigation();
          await onStarted(id);
        } else if (action === "cancel" && value.state === "cancelled") {
          await control.operation.acknowledge();
          await pending.current?.acknowledge();
          fence();
          pendingControl.current = null;
          pending.current = null;
          await recovery.refetch();
          setReceipt(null);
        } else
          throw new Error(
            "The preparation did not reach the requested state. Retry the same control.",
          );
      }
    } catch (cause) {
      if (
        activeScope.current === scope &&
        controlDispatched &&
        cause instanceof ApiRequestError &&
        [400, 403, 404, 409, 422].includes(cause.status) &&
        pendingControl.current &&
        pending.current
      ) {
        // Confirm canonical state before retiring a rejected control. A retry
        // may be denied after an earlier lost response already created a Job.
        try {
          const retained = pending.current;
          const wrapper = await parseAndVerifyTrainingExperimentSetupReceipt(
            await request("prepare-draft", retained.request),
          );
          if (
            canonicalJson(wrapper.request) !== canonicalJson(retained.request)
          )
            throw new Error(
              "The rejected training control did not reconcile its original preparation.",
            );
          const current = wrapper.preparation;
          if (
            current.plan.contentHash !== receipt?.plan.contentHash ||
            (current.state === "prepared" &&
              current.revision !==
                pendingControl.current.command.control.expectedRevision)
          )
            throw new Error(
              "Refresh the original training review before changing its control.",
            );
          await pendingControl.current.operation.acknowledge();
          fence();
          pendingControl.current = null;
          setStartAttempted(false);
          setReceipt(current);
          if (current.state !== "prepared") {
            await retained.acknowledge();
            fence();
            pending.current = null;
            if (current.state === "submitted") setRecoveredJobId(current.jobId);
            else setReceipt(null);
            await recovery.refetch();
          }
        } catch {
          /* Keep the original reviewed command when reconciliation is uncertain. */
        }
      }
      if (activeScope.current === scope) setError(cause);
    } finally {
      active.current = false;
      if (activeScope.current === scope) setBusy(false);
    }
  }
  return {
    inputs,
    recipe,
    setRecipe,
    batch,
    setBatch,
    selectedBatch,
    evaluation,
    setEvaluation,
    validationSplit,
    setValidationSplit,
    name,
    setName,
    startingModelLabel,
    budget,
    setBudget,
    customerCapUsd,
    setCustomerCapUsd,
    billingMode: receipt ? receipt.plan.usageQuote ? "actual_usage" as const : "prepaid_only" as const : billingMode,
    setBillingMode,
    gpuSelection,
    setGpuSelection,
    compute,
    funding,
    billingReturnPending,
    openBilling: onSaveDraft ? openBilling : null,
    refreshCredits,
    startAttempted,
    pendingAction: pendingControl.current?.command.action ?? null,
    recovery,
    requiresRecovery: Boolean(!pending.current && recovery.data?.review),
    canRecover: Boolean(
      (!pending.current && recovery.data?.review) ||
      (pending.current && receipt && receipt.state !== "prepared"),
    ),
    receipt,
    recoveredJobId,
    openRecoveredJob: async () => {
      if (!recoveredJobId || active.current) return;
      await guard.requestLeave(() => {
        guard.allowNextNavigation();
        void Promise.resolve(onStarted(recoveredJobId)).catch((cause) => {
          if (activeScope.current === scope) setError(cause);
        });
      });
    },
    busy,
    locked,
    error: error ?? recovery.error,
    guard,
    assertCurrentScope: fence,
    perform,
    saveDraft: onSaveDraft ? saveDraft : null,
  };
}
