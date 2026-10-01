import {useReviewedOperationRecovery} from "./useReviewedOperationRecovery";
import {ReviewedOperationRecoveryList} from "./ReviewedOperationRecoveryList";
import type {EvaluationOperationRecovery} from "@openpond/contracts";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { contentHash } from "@openpond/harness";
import { ModelRunSchema, type ModelRun } from "@openpond/contracts";
import {
  AdvancedRefinerEvaluationCommandSchema,AdvancedRefinerEvaluationOptionsSchema,
  verifyAdvancedRefinerEvaluationPin,
  type AdvancedRefinerEvaluationPin,
} from "openpond-sdk/advanced-refiner-evaluations";
import type { WorkspaceApi } from "./workspace-api";
import { useWorkspaceActions } from "./WorkspacePanel";
import {useEvaluationSetup} from "./EvaluationSetupState";
import {requestDesktopViewChange} from "../lab-primary-tab-state";
import {
  advancedEvaluationRequest,
  evaluationOwnerKey,
} from "./advanced-evaluation-api";
/** The existing Experiment sidebar hosts both independent Refiner targets;
 * authoring/adoption remains in Improve and does not occur on evaluation open. */
export function AdvancedRefinerEvaluationControl({
  api,
  evidence,
  onOpenRun,
}: {
  api: WorkspaceApi;
  evidence: { id: string; contentHash: string } | null;
  onOpenRun?: (id: string) => void;
}) {
  const setup=useEvaluationSetup(),current=useRef(evaluationOwnerKey(api));current.current=evaluationOwnerKey(api);
  useWorkspaceActions(evidence?[{id:"advanced-refiner",label:"Evaluate Refiner",onSelect:()=>{
    const started=evaluationOwnerKey(api);void requestDesktopViewChange(()=>{if(current.current===started)setup.openAdvanced({kind:"refiner_evaluation",evidence});});
  }}]:[]);
  void onOpenRun;
  return null;
}
export function AdvancedEditor({
  api,
  evidence,
  onDirty,
  onBusy,
  onOpenRun,
}: {
  api: WorkspaceApi;
  evidence: { id: string; contentHash: string };
  onDirty: (v: boolean) => void;
  onBusy: (v: boolean) => void;
  onOpenRun?: (id: string) => void;
}) {
  const scope = evaluationOwnerKey(api),
    current = useRef(scope);
  current.current = scope;
  const mounted = useRef(true),
    abort = useRef<AbortController | null>(null),
    pending = useRef<{
      scope: string;
      pin: AdvancedRefinerEvaluationPin;
      operation: Awaited<ReturnType<WorkspaceApi["operation"]>>;
      request: unknown;
    } | null>(null);
  const dispatchStarted = useRef(false);
  const queryClient = useQueryClient(),
    key = [
      "advanced-refiner-evaluations",
      scope,
      evidence.id,
      evidence.contentHash,
    ];
  const options = useQuery({
    queryKey: [...key, "options"],
    queryFn: async ({ signal }) =>
      AdvancedRefinerEvaluationOptionsSchema.parse(
        await advancedEvaluationRequest(
          api,
          "advanced-refiner-evaluations",
          { operation: "options", evidence },
          signal,
        ),
      ),
  });
  const models = useQuery({
    queryKey: [...key, "models"],
    queryFn: ({ signal }) =>
      api.request<{ models: Array<{ id: string; name: string }> }>(
        "graderModels",
        {},
        signal,
      ),
  });
  const recovery=useReviewedOperationRecovery(api,"advanced-refiner-start");
  const retainedRows=recovery.data?.pages.flatMap(page=>page.items)??[];
  async function discard(row:EvaluationOperationRecovery){const started=scope;setBusy(true);try{await api.recoverOperation(row).acknowledge("reviewed");if(mounted.current&&current.current===started){if(pending.current?.operation.id===row.id){pending.current=null;dispatchStarted.current=false;setPin(null);}await recovery.refetch();onDirty(false);}}catch(cause){if(mounted.current&&current.current===started)setError(cause instanceof Error?cause.message:String(cause));}finally{if(mounted.current&&current.current===started)setBusy(false);}}
  function restore(row:EvaluationOperationRecovery){try{
    if(!row.recoveryReady||contentHash(row.reviewedIntent)!==row.intentHash)throw new Error("The original reviewed intent is unavailable.");
    const request=AdvancedRefinerEvaluationCommandSchema.parse(row.command);if(request.operation!=="start")throw new Error("The retained command is not an advanced evaluation Start.");
    const exact=verifyAdvancedRefinerEvaluationPin(request.request.pin);
    if(exact.operationId!==row.id||exact.actorId!==api.actorId||exact.teamId!==api.teamId||exact.projectId!==api.projectId)throw new Error("The retained command belongs to another owner scope.");
    pending.current={scope,pin:exact,operation:api.recoverOperation(row),request};dispatchStarted.current=row.phase==="dispatching";setPin(exact);onDirty(true);setError(null);
  }catch(cause){setError(cause instanceof Error?cause.message:String(cause));}}
  const history = useQuery({
    queryKey: [...key, "history"],
    queryFn: ({ signal }) =>
      advancedEvaluationRequest<{
        items: Array<{
          id: string;
          status: string;
          mode: string;
          failure: string | null;
        }>;
      }>(api, "advanced-refiner-evaluations", { operation: "list" }, signal),
    refetchInterval: 5000,
  });
  const [profileId, setProfileId] = useState(""),
    [componentLabel, setComponentLabel] = useState(""),
    [split, setSplit] = useState("train"),
    [mode, setMode] = useState<"review_quality" | "downstream_adaptation">(
      "downstream_adaptation",
    ),
    [refinerId, setRefinerId] = useState(""),
    [localModelId, setLocalModelId] = useState(""),
    [modelId, setModelId] = useState(""),
    [budget, setBudget] = useState(1),
    [steps, setSteps] = useState(30),
    [minutes, setMinutes] = useState(10),
    [pin, setPin] = useState<AdvancedRefinerEvaluationPin | null>(null),
    [run, setRun] = useState<ModelRun | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abort.current?.abort();
    };
  }, []);
  useEffect(() => {
    onBusy(busy);
    return () => onBusy(false);
  }, [busy, onBusy]);
  const profile = options.data?.profiles.find((row) => row.id === profileId),
    component = profile?.components.find((row) => row.label === componentLabel),
    refiner = options.data?.refinerReleases.find((row) => row.id === refinerId),
    localModels =
      options.data?.models.filter(
        (row) => row.profileId === profile?.profileRef.profileId,
      ) ?? [];
  function edit(fn: () => void) {
    if (busy || pending.current) return;
    fn();
    setPin(null);
    onDirty(true);
  }
  const polling = useQuery({
    queryKey: [...key, "run", run?.id],
    enabled: Boolean(run),
    queryFn: async ({ signal }) =>
      ModelRunSchema.parse(
        await advancedEvaluationRequest(
          api,
          "advanced-refiner-evaluations",
          { operation: "read", id: run!.id },
          signal,
        ),
      ),
    refetchInterval: 3000,
  });
  useEffect(() => {
    if (polling.data?.id === run?.id && polling.data) setRun(polling.data);
  }, [polling.data, run?.id]);
  async function review() {
    if (busy || !profile || !component || !refiner) return;
    const started = scope;
    setBusy(true);
    setError(null);
    const controller = new AbortController();
    abort.current = controller;
    try {
      const intent = {
        evidence,
        profileOptionId: profile.id,
        componentLabel: component.label,
        mode,
        adaptationSplit: split,
        refinerRelease: refiner,
        maximumCostUsd: budget,
        maximumDurationMs: minutes * 60000,
        maximumModelSteps: steps,
        localModelId,
        modelId,
      };
      const operation = await api.operation("advanced-refiner-start", intent);
      if (!mounted.current || current.current !== started) return;
      const response = await advancedEvaluationRequest<{ pin: unknown }>(
          api,
          "advanced-refiner-evaluations",
          {
            operation: "prepare",
            evidence,
            profileOptionId: profile.id,
            componentLabel: component.label,
            mode,
            adaptationSplit: split,
            operationId: operation.id,
            refinerRelease: refiner,
            maximumCostUsd: budget,
            maximumDurationMs: minutes * 60000,
            maximumModelSteps: steps,
          },
          controller.signal,
        ),
        exact = verifyAdvancedRefinerEvaluationPin(response.pin);
      if (!mounted.current || current.current !== started) return;
      if (
        exact.actorId !== api.actorId ||
        exact.teamId !== api.teamId ||
        exact.projectId !== api.projectId ||
        exact.operationId !== operation.id
      )
        throw new Error("The reviewed evaluation belongs to another owner.");
      setPin(exact);
      pending.current = {
        scope: started,
        pin: exact,
        operation,
        request: {
          operation: "start",
          request: {
            pin: exact,
            modelId: localModelId,
            profileId: profile.profileRef.profileId,
            model: { providerId: "openpond", modelId },
            seed: Number(component.binding.population[0]!.seed),
            reasoningEffort: null,
          },
        },
      };
      await operation.retainCommand(pending.current.request,"reviewed");
      if(!mounted.current||current.current!==started)return;
      await recovery.refetch();
      if(!mounted.current||current.current!==started)return;
      onDirty(true);
    } catch (cause) {
      if (mounted.current && current.current === started)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current && current.current === started) setBusy(false);
      if (abort.current === controller) abort.current = null;
    }
  }
  async function editReview(){
    const retained=pending.current,started=scope;if(busy||dispatchStarted.current||!retained)return;
    setBusy(true);try{await retained.operation.acknowledge("reviewed");if(!mounted.current||current.current!==started)return;await recovery.refetch();if(!mounted.current||current.current!==started)return;pending.current=null;setPin(null);onDirty(true);}catch(cause){if(mounted.current&&current.current===started)setError(cause instanceof Error?cause.message:String(cause));}finally{if(mounted.current&&current.current===started)setBusy(false);}
  }
  async function start() {
    const retained = pending.current;
    if (busy || !retained || retained.scope !== scope) return;
    const started = scope;
    setBusy(true);
    setError(null);
    const controller = new AbortController();
    abort.current = controller;
    dispatchStarted.current = true;
    try {
      await retained.operation.retainCommand(retained.request,"dispatching");
      if(!mounted.current||current.current!==started)return;
      const value = ModelRunSchema.parse(
        await advancedEvaluationRequest(
          api,
          "advanced-refiner-evaluations",
          retained.request,
          controller.signal,
        ),
      );
      if (!mounted.current || current.current !== started) return;
      if (
        value.evaluation?.benchmarkId !== "harness-refiner" ||
        value.evaluation.advancedEvaluation?.contentHash !==
          retained.pin.contentHash
      )
        throw new Error("The run receipt differs from the frozen review.");
      setRun(value);
      await retained.operation.acknowledge();
      if (!mounted.current || current.current !== started) return;
      pending.current = null;
      dispatchStarted.current = false;
      await recovery.refetch();
      if(!mounted.current||current.current!==started)return;
      onDirty(false);
      await queryClient.invalidateQueries({ queryKey: [...key, "history"] });
    } catch (cause) {
      if (mounted.current && current.current === started)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current && current.current === started) setBusy(false);
      if (abort.current === controller) abort.current = null;
    }
  }
  async function control(action: "cancel" | "resume", id: string) {
    if (busy) return;
    const started = scope;
    setBusy(true);
    setError(null);
    try {
      const value = await advancedEvaluationRequest(
        api,
        "advanced-refiner-evaluations",
        { operation: action, id },
      );
      if (!mounted.current || current.current !== started) return;
      if (action === "resume") setRun(ModelRunSchema.parse(value));
      await queryClient.invalidateQueries({ queryKey: [...key, "history"] });
    } catch (cause) {
      if (mounted.current && current.current === started)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current && current.current === started) setBusy(false);
    }
  }
  const failure =
    error ??
    options.error?.message ??
    models.error?.message ??
    history.error?.message ??
    polling.error?.message;
  return (
    <div className="evaluation-form">
      <h2>Evaluate Refiner</h2>
      <ReviewedOperationRecoveryList items={retainedRows} busy={busy} error={recovery.error?.message} onRestore={restore} onDiscard={row=>void discard(row)} onLoadMore={recovery.hasNextPage?()=>void recovery.fetchNextPage():undefined}/>
      <p>
        Review quality scores independent retained contexts. Downstream
        adaptation measures a sequential candidate trajectory against a separate
        private holdout. Both retain the original source and current owner
        boundaries.
      </p>
      {failure ? <p role="alert">{failure}</p> : null}
      <fieldset disabled={busy || Boolean(pending.current)}>
        <label>
          Profile
          <select
            value={profileId}
            onChange={(e) =>
              edit(() => {
                setProfileId(e.target.value);
                setComponentLabel("");
                setLocalModelId("");
              })
            }
          >
            <option value="">Select actual source</option>
            {options.data?.profiles.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Component
          <select
            value={componentLabel}
            onChange={(e) => edit(() => setComponentLabel(e.target.value))}
          >
            <option value="">Select component</option>
            {profile?.components.map((row) => (
              <option key={row.label} value={row.label}>
                {row.kind} {row.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Target
          <select
            value={mode}
            onChange={(e) =>
              edit(() =>
                setMode(
                  e.target.value === "review_quality"
                    ? "review_quality"
                    : "downstream_adaptation",
                ),
              )
            }
          >
            <option value="downstream_adaptation">
              Downstream sequential adaptation
            </option>
            <option value="review_quality">Independent review quality</option>
          </select>
        </label>
        <label>
          Adaptation split
          <select
            value={split}
            onChange={(e) => edit(() => setSplit(e.target.value))}
          >
            {component?.adaptationSplits.map((row) => (
              <option key={row.split} value={row.split}>
                {row.split} / {row.taskIds.length} cases
              </option>
            ))}
          </select>
        </label>
        <label>
          Refiner release
          <select
            value={refinerId}
            onChange={(e) => edit(() => setRefinerId(e.target.value))}
          >
            <option value="">Select exact release</option>
            {options.data?.refinerReleases.map((row) => (
              <option key={row.contentHash} value={row.id}>
                {row.id} / {row.contentHash.slice(0, 12)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Actual local evaluation configuration
          <select
            value={localModelId}
            onChange={(e) => edit(() => setLocalModelId(e.target.value))}
          >
            <option value="">Select existing configuration</option>
            {localModels.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>
        </label>
        {profile && !localModels.length ? (
          <p>
            Create an actual Model configuration for this Profile before
            evaluating. A hosted configuration is not a local execution owner.
          </p>
        ) : null}
        <label>
          Foreground and Refiner model
          <select
            value={modelId}
            onChange={(e) => edit(() => setModelId(e.target.value))}
          >
            <option value="">Select admitted hosted model</option>
            {models.data?.models.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Whole run budget USD
          <input
            type="number"
            min="0.000001"
            value={budget}
            onChange={(e) => edit(() => setBudget(Number(e.target.value)))}
          />
        </label>
        <label>
          Maximum model requests
          <input
            type="number"
            min={1}
            max={500}
            value={steps}
            onChange={(e) => edit(() => setSteps(Number(e.target.value)))}
          />
        </label>
        <label>
          Maximum minutes
          <input
            type="number"
            min={1}
            max={1440}
            value={minutes}
            onChange={(e) => edit(() => setMinutes(Number(e.target.value)))}
          />
        </label>
      </fieldset>
      {component && !component.resettable ? (
        <p>
          The selected environment cannot bound live external tool charges.
          Review a released resettable environment first.
        </p>
      ) : null}
      {mode === "review_quality" && component && !component.reviewQuality ? (
        <p>
          This Dataset needs separately grounded review labels and actual
          retained native context bindings.
        </p>
      ) : null}
      {!pin ? (
        <button
          type="button"
          className="training-button"
          disabled={
            busy ||
            !profile ||
            !component?.resettable ||
            !refiner ||
            !localModels.some((row) => row.id === localModelId) ||
            !models.data?.models.some((row) => row.id === modelId) ||
            (mode === "review_quality" && !component?.reviewQuality)
          }
          onClick={() => void review()}
        >
          Review exact evaluation
        </button>
      ) : (
        <>
          <p>
            Frozen review {pin.contentHash}. Source {pin.profileRef.profileId} / {pin.baselineRelease.contentHash}; evidence {pin.evidence.id} / {pin.evidence.contentHash}; Refiner {pin.refinerRelease.id} / {pin.refinerRelease.contentHash}. Adaptation{" "}
            {pin.adaptationTaskIds.length} / holdout {pin.holdoutTaskIds.length}
            . All foreground, review and grade requests share{" "}
            {pin.maximumCostUsd} USD.
          </p>
          <button
            type="button"
            className="training-button"
            disabled={busy}
            onClick={() => void start()}
          >
            Start retained evaluation
          </button>
          <button
            type="button"
            disabled={busy || dispatchStarted.current}
            onClick={() => void editReview()}
          >
            Edit setup
          </button>
        </>
      )}
      {run ? (
        <>
          <p>
            Actual Run {run.id} / {run.status}
          </p>
          {run.failure ? <p>{run.failure}</p> : null}
          {run.receipt?.schemaVersion ===
          "openpond.advancedRefinerReviewReceipt.v1" ? (
            <p>
              Review score {run.receipt.reviewScore ?? "unavailable"} / no
              action {run.receipt.noActionCases} / routed{" "}
              {run.receipt.routedCases} / proposals {run.receipt.proposalCases}{" "}
              / cleanup {run.receipt.cleanupComplete ? "complete" : "pending"} /
              spend {run.receipt.costUsd ?? "unresolved"}
            </p>
          ) : null}
          {onOpenRun ? (
            <button type="button" onClick={() => onOpenRun(run.id)}>
              Open actual Run
            </button>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => void control("cancel", run.id)}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !["failed", "cancelled"].includes(run.status)}
            onClick={() => void control("resume", run.id)}
          >
            Resume retained run
          </button>
        </>
      ) : null}
      <ol>
        {history.data?.items.map((row) => (
          <li key={row.id}>
            {row.mode} / {row.status}
            {row.failure ? <p>{row.failure}</p> : null}
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                const started = scope;
                void advancedEvaluationRequest(
                  api,
                  "advanced-refiner-evaluations",
                  { operation: "read", id: row.id },
                )
                  .then((raw) => {
                    if (mounted.current && current.current === started)
                      setRun(ModelRunSchema.parse(raw));
                  })
                  .catch((cause) => {
                    if (mounted.current && current.current === started)
                      setError(String(cause));
                  });
              }}
            >
              Inspect actual Run
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
