import { lazy, Suspense, useContext, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import type { useChatContextSelection } from "../../hooks/useChatContextSelection";
import type { ChatResourceSummary } from "@openpond/contracts";
import { LocalTrainingComputeSchema, ownsHostedBenchmarkVersion, type LocalTrainingCompute } from "@openpond/contracts/resource-setup";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import { chatResourceRequest } from "../../api/chat-resource-api";
import { connectionQueryScope } from "../../lib/query-scope";
import type { EvaluationModel } from "../../hooks/useChatResourceFocus";
import { useErrorToast } from "../../app/AppToastContext";
import {
  localSftReviewRequest,
  retainedLocalSftApproval,
  resourceSetupGroups,
  resourceSetupLabel,
  resourceSetupParts,
  resourceSetupTrainingMethod,
  resourceSetupManagedTrainingMethod,
  resourceSetupSavedTrainingStart,
  isWeightSpaceSetup,
  scopeManagedSetup,
  benchmarkAccountMessage,
  selectModelSetupMethod,
  ResourceSetupDraftSchema,
  type ResourceSetupDraft,
  type ResourceSetupField,
  type ResourceSetupPart,
} from "../../lib/resource-setup-prompt";
import type { DropdownOption } from "../../lib/app-models";
import { DropdownSelect } from "../DropdownSelect";
import { AppDialog } from "../dialogs/AppDialog";
import { ChevronDown, SlidersHorizontal } from "../icons";
import { DesktopNewContext } from "./DesktopNewMenu";
import { DatasetSetupReview } from "./DatasetSetupReview";
import { GraderSetupReview } from "./GraderSetupReview";
import { ModelSetupTrainingFields } from "./ModelSetupTrainingFields";
import { ModelSetupManagedReview } from "./ModelSetupManagedReview";
import { ModelSetupLocalBase } from "./ModelSetupLocalBase";
import { ModelSetupLocalSftReview } from "./ModelSetupLocalSftReview";
import { SavedTrainingVersionPicker, type BenchmarkVersionChoiceValue } from "../labs/workspace/BenchmarkVersionChoice";
import { createWorkspaceApi } from "../labs/workspace/workspace-api";
import { ManagedBenchmarkProtocolFields } from "./ManagedBenchmarkProtocolFields";
import { ManagedBenchmarkDatasetFields } from "./ManagedBenchmarkDatasetFields";
import { LocalAdapterBenchmarkReview } from "./LocalAdapterBenchmarkReview";
import { ChatExperimentWorkspaceContext } from "./ChatExperimentWorkspaceContext";
import { DecisionTrainingFields } from "../labs/workspace/DecisionFields";
import { initialDecisionTraining } from "../labs/workspace/decision-form-defaults";
import { WeightSpacePromptFields } from "./WeightSpacePromptFields";
import "./resource-setup-editor.css";

const GraderSetupWorkspaceReview = lazy(() => import("./GraderSetupWorkspaceReview"));

type PromptField = Exclude<ResourceSetupPart, string>["field"];

const labels: Record<ResourceSetupField, string> = {
  name: "Name", objective: "Objective", baseModel: "Starting model or exact checkpoint",
  candidate: "Candidate version", baseline: "Baseline version", dataset: "Dataset",
  datasetRevision: "Dataset revision", split: "Split", grader: "Graders",
  method: "Training method", adapter: "Adapter", learning: "Continual learning", destination: "Execution destination",
  source: "Dataset source", graderType: "Grader type", fields: "Input and expected output fields",
  samples: "Sample count", outputTokens: "Maximum output tokens", epochs: "Epochs", learningRate: "Learning rate", seed: "Seed",
  budget: "Maximum spend in USD", criterion: "Scoring criterion", cases: "Passing and failing examples", project: "Project",
};
const runtimePreflightReasons: Record<Exclude<NonNullable<LocalTrainingCompute["runtime"]>["status"], "ready">, string> = {
  unsupported_platform: "The local CUDA runtime requires Linux.",
  python_missing: "Set up the local training Python environment.",
  dependencies_missing: "Check the packages in the local training Python environment.",
  cuda_unusable: "The local PyTorch runtime could not run a CUDA operation.",
  probe_failed: "The local training runtime check could not finish.",
};

function describeLocalTrainingCompute(data: LocalTrainingCompute | undefined, checking: boolean): string | null {
  if (checking) return "Checking this device.";
  if (!data) return "Training on this device is unavailable.";
  if (data.status === "cuda_tools_unavailable") return "CUDA tools are unavailable on this device.";
  if (data.status === "devices_unavailable") return "CUDA devices did not report capacity.";
  const runtime = data.runtime;
  if (runtime?.status === "ready") return null;
  return runtime ? runtimePreflightReasons[runtime.status] : "Set up the local CUDA training runtime.";
}

const choices: Partial<Record<ResourceSetupField, readonly string[]>> = {
  method: ["SFT", "GRPO", "Decision", "Weight-space programming"],
  adapter: ["LoRA", "Full fine-tuning"],
  learning: ["One-time training", "Configure continual learning"],
  source: ["Write examples", "Import a local file", "Use an existing dataset"],
  split: ["train", "validation", "test", "frozen_eval"],
  graderType: ["Exact answer", "Code grader", "LLM judge", "Human assessment", "Python correctness"],
};
const decimalFields = new Set<ResourceSetupField>(["budget", "learningRate"]);
const integerFields = new Set<ResourceSetupField>(["datasetRevision", "epochs", "samples", "seed"]);

export function ResourceSetupEditor({ draft, configureTarget, busy: composerBusy, connection, datasets, evaluationModels, sessionId, context, onAttachDataset, onChange, onRemove }: {
  draft: ResourceSetupDraft;
  configureTarget: HTMLElement | null;
  busy: boolean;
  connection: ClientConnection | null;
  datasets: readonly ChatResourceSummary[];
  evaluationModels: readonly EvaluationModel[];
  sessionId: string | null;
  context: Pick<ReturnType<typeof useChatContextSelection>, "select" | "selection" | "selecting">;
  onAttachDataset(reference: NonNullable<ResourceSetupDraft["datasetRef"]>): Promise<boolean>;
  onChange(current: ResourceSetupDraft, next: ResourceSetupDraft): void;
  onRemove(): void;
}) {
  const managedAvailable = useContext(DesktopNewContext)?.managedAvailable ?? false;
  const workspace = useContext(ChatExperimentWorkspaceContext);
  const visibleDraft = scopeManagedSetup(draft, workspace, context.selection, sessionId);
  const version = visibleDraft.benchmarkModelVersion;
  const benchmarkUnavailable = draft.benchmarkModelVersion?.location === "cloud" && !version ||
    Boolean(draft.managedBenchmarkVersions && !visibleDraft.managedBenchmarkVersions) ||
    Boolean(draft.managedBenchmarkDataset && !visibleDraft.managedBenchmarkDataset);
  const benchmarkApi = draft.kind === "benchmark" && connection && workspace?.teamId && workspace.actorId && workspace.apiOrigin &&
    draft.values.destination === "OpenPond Managed" ? createWorkspaceApi(connection, {
      ...workspace, teamId: workspace.teamId, actorId: workspace.actorId, projectId: null, executionLocation: "hosted",
    }) : null;
  const pinnedCandidate = version?.location === "cloud" && version.owner ? { ...version, owner: version.owner } : undefined;
  const managedVersions = visibleDraft.managedBenchmarkVersions ?? (pinnedCandidate ? { candidate: pinnedCandidate } : undefined);
  const reviewVersions = managedVersions &&
    (draft.comparison ? managedVersions : { candidate: managedVersions.candidate });
  const selectedVersion = context.selection?.benchmarkVersion;
  const evaluationForm = context.selection?.target.sessionId === sessionId && selectedVersion?.location === "cloud" &&
    ownsHostedBenchmarkVersion(selectedVersion, workspace) ? context.selection?.draft?.evaluationForm : undefined;
  const retainedProtocol = evaluationForm?.executionLocation === "hosted" && evaluationForm.form.mode === "model"
    ? evaluationForm.form : undefined;
  const protocol = visibleDraft.managedBenchmarkProtocol;
  const retainedSampling = retainedProtocol && (retainedProtocol.temperature !== undefined || retainedProtocol.topP !== undefined)
    ? { temperature: retainedProtocol.temperature === undefined ? 0 : retainedProtocol.temperature,
      topP: retainedProtocol.topP === undefined ? 1 : retainedProtocol.topP } : undefined;
  const sampling = protocol?.sampling === undefined ? retainedSampling : protocol.sampling;
  const openableVersion = version?.location === "cloud" && selectedVersion?.location === "cloud" &&
    version.versionHash === selectedVersion.versionHash && context.selection?.target.sessionId === sessionId;
  const managedReview = Boolean(workspace?.teamId && workspace.actorId && connection && sessionId &&
    resourceSetupManagedTrainingMethod(draft) && draft.values.destination === "OpenPond Managed");
  const supportsLocalTraining = draft.values.method === "SFT" && draft.values.adapter === "LoRA" &&
    draft.values.learning !== "Configure continual learning";
  const localBase = draft.kind === "model" && draft.values.destination !== "OpenPond Managed" ? draft.localTrainingBase : undefined;
  const [configureOpen, setConfigureOpen] = useState(false);
  const [openGraderScope, setOpenGraderScope] = useState<string | null>(null);
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  const [field, setField] = useState<PromptField>("name");
  const [authoringBusy, setAuthoringBusy] = useState(false);
  const [benchmarkError, setBenchmarkError] = useState<unknown>(null);
  useErrorToast(benchmarkError);
  const busy = composerBusy || authoringBusy;
  const graderType = draft.kind === "grader" ? draft.values.graderType : undefined;
  const workspaceGraderMethod = graderType === "LLM judge" || graderType === "Human assessment" || graderType === "Python correctness"
    ? graderType : null;
  const graderScope = managedAvailable && workspace?.teamId && workspace.actorId
    ? { accountKey: workspace.accountKey, teamId: workspace.teamId, actorId: workspace.actorId } : null;
  const graderScopeKey = graderScope && workspaceGraderMethod ? JSON.stringify([graderScope, workspaceGraderMethod]) : null;
  const compute = useQuery({
    queryKey: ["local-training-compute", connectionQueryScope(connection)],
    enabled: Boolean(connection && draft.kind === "model" && configureOpen && field === "destination"),
    queryFn: async ({ signal }) => LocalTrainingComputeSchema.parse(await apiFetch(
      connection!, "/v1/training/local-compute", { signal },
    )),
    retry: false,
    staleTime: 30_000,
  });
  const starterDatasets = useQuery({
    queryKey: ["setup-local-datasets", connectionQueryScope(connection)],
    enabled: Boolean(connection && !sessionId && draft.kind === "model" && configureOpen && field === "dataset"),
    queryFn: ({ signal }) => chatResourceRequest<ChatResourceSummary[]>(connection!, "dataset", { action: "list" }, signal),
    retry: false,
  });
  useErrorToast(starterDatasets.error);
  const parts = resourceSetupParts(visibleDraft);
  const localDatasets = (sessionId ? datasets : starterDatasets.data ?? []).filter(dataset => dataset.location !== "cloud");
  const localModels = evaluationModels.flatMap(model => model.providerId === "custom-openai-compatible" &&
    model.configurationHash && /^[a-f0-9]{64}$/.test(model.configurationHash)
    ? [{ modelId: model.id, name: model.name ?? model.id, configurationHash: model.configurationHash }] : []);
  const localModelValue = (model: { modelId: string; configurationHash: string }) => JSON.stringify([model.modelId, model.configurationHash]);
  const datasetValue = (dataset: Pick<ChatResourceSummary, "id" | "revision">) => JSON.stringify([dataset.id, dataset.revision]);
  function showField(next: PromptField) {
    setField(next);
    setConfigureOpen(true);
  }
  function change(key: ResourceSetupField, raw: string) {
    if (key === "method") {
      const method = ResourceSetupDraftSchema.shape.values.shape.method.safeParse(raw || undefined);
      if (method.success) onChange(draft, selectModelSetupMethod(draft, method.data));
      return;
    }
    const leavingLocal = key === "destination" && draft.values.destination === "This device" && raw !== "This device";
    const invalidatesLocalTraining = draft.kind === "model" && draft.values.destination === "This device" &&
      (key === "adapter" && raw !== "LoRA" ||
        key === "learning" && raw === "Configure continual learning");
    const leavingManagedBenchmark = draft.kind === "benchmark" && key === "destination" &&
      draft.values.destination === "OpenPond Managed" && raw !== "OpenPond Managed";
    const enteringManagedBenchmark = draft.kind === "benchmark" && key === "destination" &&
      draft.values.destination !== "OpenPond Managed" && raw === "OpenPond Managed";
    const sourceChanged = draft.kind === "dataset" && key === "source" && raw !== draft.values.source;
    const datasetEdited = draft.kind === "dataset" && ["name", "objective", "split"].includes(key);
    const parsed = ResourceSetupDraftSchema.safeParse({
      ...draft,
      revision: draft.revision + 1,
      ...(key === "candidate" ? { candidateRef: undefined } : {}),
      ...(key === "baseModel" && draft.values.destination !== "OpenPond Managed" ? { localTrainingBase: undefined } : {}),
      ...(leavingLocal ? { localCandidate: undefined, localBaseline: undefined } : {}),
      ...(leavingManagedBenchmark ? { managedBenchmarkVersions: undefined, managedBenchmarkDataset: undefined,
        managedBenchmarkProtocol: undefined } : {}),
      ...(enteringManagedBenchmark ? { datasetRef: undefined } : {}),
      ...(sourceChanged ? { datasetRef: undefined, datasetExamples: undefined } : {}),
      ...(datasetEdited ? { datasetInputsDirty: true } : {}),
      values: {
        ...draft.values,
        ...(leavingLocal && draft.localCandidate ? { candidate: undefined } : {}),
        ...(leavingLocal && draft.localBaseline ? { baseline: undefined } : {}),
        ...(leavingManagedBenchmark ? { candidate: undefined, baseline: undefined, outputTokens: undefined } : {}),
        ...(leavingManagedBenchmark || enteringManagedBenchmark ? {
          dataset: undefined, datasetRevision: undefined, split: undefined, grader: undefined,
        } : {}),
        ...(sourceChanged ? { dataset: undefined, datasetRevision: undefined, fields: undefined } : {}),
        ...(invalidatesLocalTraining ? { destination: undefined } : {}),
        [key]: raw === "" ? undefined : decimalFields.has(key) || integerFields.has(key) ? Number(raw) : raw,
      },
    });
    if (parsed.success) onChange(draft, parsed.data);
  }
  function chooseManagedVersion(key: "candidate" | "baseline", choice: BenchmarkVersionChoiceValue | null) {
    if (!workspace?.apiOrigin || !workspace.actorId || !workspace.teamId) return;
    if (choice && choice.version.teamId !== workspace.teamId) return;
    const pin = choice ? {
      location: "cloud" as const, modelProjectId: choice.version.modelProjectId, jobId: choice.version.jobId,
      teamId: choice.version.teamId, versionHash: choice.version.contentHash,
      owner: { actorId: workspace.actorId, apiOrigin: workspace.apiOrigin },
    } : undefined;
    const selectedCandidate = key === "candidate" ? pin : managedVersions?.candidate;
    const selectedBaseline = key === "baseline" ? pin : managedVersions?.baseline;
    const baseline = selectedCandidate && selectedBaseline?.jobId !== selectedCandidate.jobId ? selectedBaseline : undefined;
    onChange(draft, {
      ...draft, revision: draft.revision + 1,
      managedBenchmarkVersions: selectedCandidate ? { candidate: selectedCandidate, baseline } : undefined,
      values: { ...draft.values, [key]: choice?.label, ...(!baseline ? { baseline: undefined } : {}) },
    });
  }
  function chooseDataset(value: string) {
    const reference = localDatasets.find(dataset => datasetValue(dataset) === value);
    onChange(draft, {
      ...draft,
      revision: draft.revision + 1,
      datasetRef: reference && { id: reference.id, revision: reference.revision, contentHash: reference.evaluationHash ?? reference.contentHash },
      ...(draft.kind === "grader" && reference?.id !== draft.datasetRef?.id ? { graderExamples: undefined } : {}),
      ...(draft.kind === "model" && draft.managedTrainingInputs ? {
        managedTrainingInputs: { ...draft.managedTrainingInputs, batch: undefined },
      } : {}),
      ...(draft.kind === "dataset" ? { datasetInputsDirty: false } : {}),
      values: { ...draft.values, dataset: reference?.name, datasetRevision: reference?.revision, grader: undefined },
    });
  }
  function fieldOptions(key: ResourceSetupField): DropdownOption[] | null {
    if (key === "adapter" && ["SFT", "GRPO"].includes(draft.values.method ?? "")) return [
      { value: "", label: "Choose later" },
      { value: "LoRA", label: "LoRA" },
      { value: "Full fine-tuning", label: "Full fine-tuning", disabled: true, description: "The current SFT and GRPO runners use LoRA." },
    ];
    if (key === "destination") {
      const localReason = draft.kind === "model"
        ? supportsLocalTraining ? describeLocalTrainingCompute(compute.data, compute.isFetching)
          : "Choose SFT with LoRA and one-time training to use this device."
        : draft.kind === "benchmark" && context.selection?.managedBenchmarkVersions
          ? "Create a local Benchmark to run on this device."
          : draft.kind === "benchmark" && version?.location !== "local" && !localModels.length
            ? "Configure a compatible loopback model in provider settings." : null;
      return [
        { value: "", label: "Choose a destination" },
        { value: "This device", label: "This device", disabled: Boolean(localReason),
          description: localReason ?? (draft.kind === "model" ? "Check the exact checkpoint, Dataset, and recipe before starting." : undefined) },
        { value: "OpenPond Managed", label: "OpenPond Managed", disabled: !managedAvailable, description: managedAvailable ? undefined : "Sign in and select a workspace." },
      ];
    }
    const options = choices[key];
    return options ? [{ value: "", label: "Choose later" }, ...options.map(value => ({ value, label: value }))] : null;
  }
  const sentence = (inline = false) => benchmarkUnavailable ? <p>{benchmarkAccountMessage}</p> : <div className="resource-setup-sentence">
    {parts.map((part, index) => {
      if (typeof part === "string") return part;
      if (inline && (part.field === "method" || part.field === "adapter" || part.field === "source" || part.field === "graderType")) {
        const key = part.field;
        const options = fieldOptions(key);
        if (options) return <DropdownSelect key={index} className="resource-setup-inline-select" floating floatingMenuWidth={245}
          label={`Edit ${part.placeholder}`} value={visibleDraft.values[key] ?? ""} options={options} disabled={busy}
          triggerContent={<>{resourceSetupLabel(part, visibleDraft)} <ChevronDown aria-hidden="true" size={12} /></>}
          onChange={value => change(key, value)} />;
      }
      return <button key={index} className="resource-setup-pill" type="button" disabled={busy} aria-label={`Edit ${part.placeholder}`}
        data-active={configureOpen && part.field === field || undefined} onClick={() => showField(part.field)}>
        {resourceSetupLabel(part, visibleDraft)} <ChevronDown aria-hidden="true" size={12} />
      </button>;
    })}
  </div>;
  const activePart = parts.find(part => typeof part !== "string" && part.field === field);
  const trainingMethod = field === "trainingSettings" ? resourceSetupTrainingMethod(draft) : null;
  const decisionSettings = field === "trainingSettings" && resourceSetupManagedTrainingMethod(draft) === "decision_model";
  const weightSpaceField = isWeightSpaceSetup(draft) && (field === "baseModel" || field === "weightSpacePanels" ||
    field === "weightSpaceFrozen" || field === "weightSpaceSettings") ? field : null;
  const localSft = draft.values.destination !== "OpenPond Managed" && resourceSetupTrainingMethod(draft) === "sft";
  const reviewInputs = localSft && (field === "dataset" || field === "trainingSettings");
  const reviewRequest = reviewInputs ? localSftReviewRequest(draft, sessionId) : null;
  const activeFields: readonly ResourceSetupField[] = weightSpaceField ? [] : trainingMethod || decisionSettings ? ["budget"]
    : resourceSetupGroups[field] ?? [field as ResourceSetupField];
  const benchmarkPresets = draft.kind === "benchmark" && !benchmarkUnavailable && version?.location !== "local" ? <div className="resource-setup-presets" role="group" aria-label="Benchmark presets">
    {[{ compare: false, label: "Evaluate one model" }, { compare: true, label: "Compare models" }].map(({ compare, label }) =>
      <button type="button" className="training-button secondary" key={label} disabled={busy}
        aria-pressed={Boolean(draft.comparison) === compare}
        onClick={() => onChange(draft, { ...draft, revision: draft.revision + 1, comparison: compare })}>{label}</button>)}
  </div> : null;
  return <div className="resource-setup-editor">
    {benchmarkPresets}
    {sentence(true)}
    {configureTarget ? createPortal(<button type="button" className="training-text-button resource-setup-configure" disabled={busy || benchmarkUnavailable} onClick={() => {
      setField(parts.find((part): part is Exclude<ResourceSetupPart, string> => typeof part !== "string")?.field ?? "name");
      setConfigureOpen(true);
    }}>
      <SlidersHorizontal size={13} aria-hidden="true" /> Configure
    </button>, configureTarget) : null}
    {configureOpen && !benchmarkUnavailable ? createPortal(<AppDialog ariaLabel="Configure prompt" className="training-dialog resource-setup-dialog" initialFocusKey={field}
      dismissDisabled={authoringBusy} onClose={() => setConfigureOpen(false)}>
      <h2>Configure prompt</h2>
      <div className="training-dialog-scroll-body resource-setup-dialog-body">
      {sentence()}
      {benchmarkPresets}
      {trainingMethod && <ModelSetupTrainingFields key={trainingMethod} draft={draft} method={trainingMethod}
        baseModel={resourceSetupSavedTrainingStart(visibleDraft)?.base ?? visibleDraft.managedTrainingInputs?.base?.preference ?? localBase?.preference}
        disabled={busy} onChange={onChange} />}
      {decisionSettings && <fieldset className="resource-setup-fields resource-setup-training-fields resource-setup-protocol-fields" disabled={busy}>
        <legend>Optimizer and limits</legend>
        <DecisionTrainingFields training={draft.decisionTraining ?? initialDecisionTraining()} onChange={decisionTraining =>
          onChange(draft, { ...draft, revision: draft.revision + 1, decisionTraining })} />
      </fieldset>}
      {weightSpaceField && <WeightSpacePromptFields field={weightSpaceField} draft={draft} visible={visibleDraft}
        connection={connection} disabled={busy} onChange={onChange} />}
      {activePart && activeFields.length ? <div className="resource-setup-fields" key={field}>
        {activeFields.map((key, index) => {
          if (version?.location === "local") return null;
          const options = fieldOptions(key);
          const label = field === "saveDestination" ? "Save to" : labels[key];
          if (benchmarkApi && ["dataset", "datasetRevision", "split", "grader"].includes(key)) return null;
          if (version && ["candidate", "dataset", "datasetRevision", "grader", "destination"].includes(key)) return null;
          if (draft.kind === "benchmark" && (key === "candidate" || key === "baseline") &&
            draft.values.destination !== "This device") {
            if (!benchmarkApi) return <p key={key}>Choose a workspace and execution destination to browse saved Model versions.</p>;
            if (key === "baseline" && !managedVersions?.candidate) return <p key={key}>Choose a candidate version first.</p>;
            const pin = managedVersions?.[key];
            return <SavedTrainingVersionPicker key={key} api={benchmarkApi} label={label} autoFocus={index === 0}
              selected={pin && { jobId: pin.jobId, versionHash: pin.versionHash, label: draft.values[key] ?? label }}
              excludedJobId={key === "baseline" ? managedVersions?.candidate.jobId : undefined}
              disabled={busy} onSelect={choice => chooseManagedVersion(key, choice)} />;
          }
          if (draft.kind === "grader" && draft.values.graderType === "Exact answer" && key === "cases") return null;
          if (managedReview && key === "baseModel") return null;
          if (localBase && key === "baseModel") return null;
          if (localSft && key === "split") return null;
          if (draft.kind === "dataset" && (key === "fields" && draft.values.source === "Import a local file"
            || field === "preview" && draft.values.source === "Use an existing dataset")) return null;
          if (key === "grader" && draft.kind === "benchmark" && draft.values.destination === "This device") {
            return <div className="resource-setup-input" key={key}>
              <span>{label}</span>
              <p>This device runs the local graders saved with the selected Dataset revision.</p>
            </div>;
          }
          if ((key === "candidate" || key === "baseline") && draft.values.destination === "This device") {
            const pin = key === "candidate" ? "localCandidate" : "localBaseline";
            const selected = draft[pin];
            const value = selected ? localModelValue(selected) : "";
            const options = localModels.map(model => ({ value: localModelValue(model), label: model.name }));
            return <div className="resource-setup-input" key={key}>
              <span>{key === "candidate" ? "Local candidate" : "Local baseline"}</span>
              <DropdownSelect label={label} value={value} searchable
                options={[{ value: "", label: "Choose a qualified local model" }, ...options]}
                dialogAutoFocus={index === 0}
                disabled={busy} onChange={raw => {
                  const model = localModels.find(candidate => localModelValue(candidate) === raw);
                  onChange(draft, {
                    ...draft, revision: draft.revision + 1,
                    ...(key === "candidate" ? { candidateRef: undefined } : {}),
                    [pin]: model && { modelId: model.modelId, configurationHash: model.configurationHash },
                    values: { ...draft.values, [key]: model?.name },
                  });
                }} />
            </div>;
          }
          if (key === "dataset" && (localDatasets.length || draft.datasetRef)) {
            const value = draft.datasetRef ? datasetValue(draft.datasetRef) : "";
            const options = localDatasets.map(dataset => ({ value: datasetValue(dataset), label: `${dataset.name} revision ${dataset.revision}` }));
            const retained = value && !options.some(option => option.value === value)
              ? [{ value, label: visibleDraft.values.dataset ?? "Selected dataset revision" }] : [];
            return <div className="resource-setup-input" key={key}>
              <span>{label}</span>
              <DropdownSelect label={label} value={value} searchable
                options={[{ value: "", label: visibleDraft.values.dataset && !value ? visibleDraft.values.dataset : "Choose a local dataset" }, ...retained, ...options]}
                dialogAutoFocus={index === 0}
                disabled={busy} onChange={chooseDataset} />
            </div>;
          }
          if (key === "datasetRevision" && draft.datasetRef) return null;
          return options ? <div className="resource-setup-input" key={key}>
            <span>{label}</span>
            <DropdownSelect label={label} options={options} value={String(draft.values[key] ?? "")}
              dialogAutoFocus={index === 0}
              disabled={busy} onChange={value => change(key, value)} />
          </div> : <label className="resource-setup-input" key={key}>
            {label}
            <input
              data-autofocus={index === 0 || undefined}
              type={decimalFields.has(key) || integerFields.has(key) ? "number" : "text"}
              step={decimalFields.has(key) ? "any" : undefined}
              min={["datasetRevision", "epochs", "samples"].includes(key) ? 1 : 0}
              max={key === "samples" ? 100 : undefined}
              maxLength={(draft.kind === "model" || draft.kind === "benchmark") && key === "name" ? 191 : 2_000}
              disabled={busy}
              value={visibleDraft.values[key] ?? ""}
              onChange={event => change(key, event.target.value)}
              onKeyDown={event => { if (event.key === "Enter") event.preventDefault(); }}
            />
          </label>;
        })}
      </div> : null}
      {benchmarkApi && field === "evaluationSettings" && <ManagedBenchmarkProtocolFields
        connection={benchmarkApi.connection} scope={benchmarkApi.key} versions={reviewVersions} comparison={Boolean(draft.comparison)}
        disabled={busy || context.selecting}
        draft={{ seed: protocol?.environmentSeeds ?? retainedProtocol?.seed ?? "",
          prompt: protocol?.systemInstructions ?? retainedProtocol?.prompt ?? "",
          outputTokens: draft.values.outputTokens ?? retainedProtocol?.outputTokens ?? null,
          temperature: sampling?.temperature, topP: sampling?.topP }}
        onChange={patch => {
          const nextSampling = "temperature" in patch || "topP" in patch
            ? patch.temperature === undefined && patch.topP === undefined ? null : {
              temperature: "temperature" in patch ? patch.temperature ?? null : sampling ? sampling.temperature : 0,
              topP: "topP" in patch ? patch.topP ?? null : sampling ? sampling.topP : 1,
            } : protocol?.sampling;
          const updated = ResourceSetupDraftSchema.safeParse({
            ...draft, revision: draft.revision + 1,
            values: { ...draft.values, ...("outputTokens" in patch ? { outputTokens: patch.outputTokens ?? undefined } : {}) },
            managedBenchmarkProtocol: {
              environmentSeeds: patch.seed ?? protocol?.environmentSeeds,
              systemInstructions: patch.prompt ?? protocol?.systemInstructions,
              sampling: nextSampling,
            },
          });
          if (updated.success) onChange(draft, updated.data);
        }} />}
      {benchmarkApi && workspace?.actorId && workspace.apiOrigin && (field === "dataset" || field === "grader") ? (
        <ManagedBenchmarkDatasetFields key={benchmarkApi.key} api={benchmarkApi} field={field}
          owner={{ actorId: workspace.actorId, apiOrigin: workspace.apiOrigin }}
          current={visibleDraft.managedBenchmarkDataset} split={draft.values.split} disabled={busy || context.selecting}
          onSplit={split => change("split", split ?? "")}
          onChoose={(dataset, split) => {
            onChange(draft, { ...draft, revision: draft.revision + 1, managedBenchmarkDataset: dataset, datasetRef: undefined,
              values: { ...draft.values, split, dataset: undefined, datasetRevision: undefined, grader: undefined,
                ...(dataset === null ? { samples: undefined } : {}) } });
          }} />
      ) : null}
      {field === "baseModel" && draft.kind === "model" && (localSft || !draft.values.method && draft.values.destination !== "OpenPond Managed") && connection ? (
        <div className="resource-setup-fields">
          <ModelSetupLocalBase connection={connection} selected={localBase} busy={busy} onBusy={setAuthoringBusy}
            onSelect={base => onChange(draft, {
              ...draft, revision: draft.revision + 1, localTrainingBase: base,
              values: { ...draft.values, baseModel: base ? undefined : draft.values.baseModel },
            })} />
        </div>
      ) : null}
      {reviewInputs && (reviewRequest && connection ? (
        <ModelSetupLocalSftReview key={JSON.stringify(reviewRequest)} connection={connection} request={reviewRequest}
          approval={retainedLocalSftApproval(draft, sessionId)} busy={busy} onBusy={setAuthoringBusy}
          localSelected={supportsLocalTraining && draft.values.destination === "This device"}
          onApprove={approval => onChange(draft, { ...draft, revision: draft.revision + 1, localSftApproval: approval })} />
      ) : <p>{localBase && draft.datasetRef ? "Check the local SFT settings before reviewing training examples."
        : "Choose a local checkpoint and Dataset to review training examples."}</p>)}
      {version?.location === "local" && connection && sessionId && <LocalAdapterBenchmarkReview
        connection={connection} sessionId={sessionId}
        initial={{
          name: draft.values.name, split: draft.values.split, samples: draft.values.samples, seed: draft.values.seed,
          ...draft.localBenchmarkInference,
          dataset: draft.datasetRef?.contentHash ? { ...draft.datasetRef, contentHash: draft.datasetRef.contentHash } : undefined,
        }}
        onReviewed={(setup, name, baseline) => onChange(draft, {
          ...draft, revision: draft.revision + 1, comparison: Boolean(baseline), datasetRef: setup.dataset,
          localBenchmarkInference: { device: setup.device, maxOutputTokens: setup.maxOutputTokens, baseline: setup.baseline },
          values: { ...draft.values, name, baseline, destination: "This device", split: setup.split,
            samples: setup.samples, seed: setup.seed, dataset: localDatasets.find(item => item.id === setup.dataset.id)?.name,
            datasetRevision: setup.dataset.revision },
        })} />}
      {(version?.location === "cloud" || benchmarkApi) && <button type="button" className="training-button secondary"
        disabled={busy || context.selecting || !sessionId || !context.selection?.draftRevision ||
          (!managedVersions && !openableVersion) || Boolean(draft.comparison && !managedVersions?.baseline)}
        onClick={async () => {
          setBenchmarkError(null);
          try {
            const selected = context.selection;
            if (!selected || selected.target.sessionId !== sessionId || !selected.draftRevision) return;
            if (await context.select(selected.target, { configureDraft: true, ...(reviewVersions ? {
              benchmark: { versions: reviewVersions, expectedRevision: selected.draftRevision, name: draft.values.name?.trim() || undefined,
                budget: draft.values.budget, seed: draft.values.seed, outputTokens: draft.values.outputTokens,
                dataset: visibleDraft.managedBenchmarkDataset,
                split: draft.values.split, samples: draft.values.samples,
                protocol: protocol?.environmentSeeds === undefined && draft.values.seed !== undefined && retainedProtocol?.seed
                  ? { ...protocol, environmentSeeds: retainedProtocol.seed } : protocol },
            } : {}) })) setConfigureOpen(false);
          } catch (cause) { setBenchmarkError(cause); }
        }}>Open Benchmark review</button>}
      {draft.kind === "dataset" && <DatasetSetupReview draft={draft} connection={connection}
        sessionId={sessionId} busy={busy} managedAvailable={managedAvailable} activeField={field}
        onChange={onChange} onAttach={onAttachDataset} onBusy={setAuthoringBusy} />}
      {managedReview && <ModelSetupManagedReview draft={draft} connection={connection} sessionId={sessionId}
        context={context} field={field} busy={busy || context.selecting}
        onChange={onChange} onBusy={setAuthoringBusy} onOpened={() => setConfigureOpen(false)} />}
      {draft.kind === "grader" && (draft.values.graderType === "Exact answer" || draft.values.graderType === "Code grader") && <GraderSetupReview
        draft={draft} connection={connection} busy={busy}
        active={field === "cases" || field === "criterion" && draft.values.graderType === "Code grader"} managedAvailable={managedAvailable}
        onChange={onChange} onAttach={onAttachDataset} onBusy={setAuthoringBusy} />}
      {workspaceGraderMethod ? <div className="resource-setup-fields">
        {visibleDraft.managedGrader?.release ? <span>Published Grader revision {visibleDraft.managedGrader.release.revision}</span>
          : visibleDraft.managedGrader?.draft ? <span>Workspace Grader draft revision {visibleDraft.managedGrader.draft.revision}</span> : null}
        <button type="button" className="training-button secondary" disabled={busy || !connection || !graderScope}
          onClick={() => { setConfigureOpen(false); setOpenGraderScope(graderScopeKey); }}>Open workspace Grader review</button>
        {!graderScope ? <p>Sign in and select a workspace to review and publish this Grader.</p> : null}
      </div> : null}
      </div>
      <footer className="training-dialog-actions">
        <button type="button" className="training-button secondary" disabled={busy} onClick={onRemove}>Remove setup</button>
        <button type="button" className="training-button" disabled={authoringBusy} onClick={() => setConfigureOpen(false)}>Done</button>
      </footer>
    </AppDialog>, document.body) : null}
    {workspaceGraderMethod && graderScope && graderScopeKey === openGraderScope && connection ? <Suspense fallback={null}>
      <GraderSetupWorkspaceReview key={graderScopeKey} connection={connection}
        scope={graderScope} method={workspaceGraderMethod} selection={visibleDraft.managedGrader}
        name={draft.values.name} criterion={draft.values.criterion}
        onChange={(pin, values) => {
          const current = latestDraft.current;
          const criterion = ResourceSetupDraftSchema.shape.values.shape.criterion.safeParse(values?.criterion ?? current.values.criterion);
          onChange(current, {
            ...current, revision: current.revision + 1, managedGrader: pin,
            values: { ...current.values, ...values, criterion: criterion.success ? criterion.data : "Use the rubric saved in workspace Grader review." },
          });
        }}
        onClose={() => { setOpenGraderScope(null); setConfigureOpen(true); }} />
    </Suspense> : null}
  </div>;
}
