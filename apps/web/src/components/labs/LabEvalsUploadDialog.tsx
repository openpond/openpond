import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ContinualLearningDailyBatchManifest,
  ContinualLearningResponseTarget,
  ModelComparisonSeries,
  TrainingStateResponse,
} from "@openpond/contracts";

import type { useTraining } from "../../hooks/useTraining";
import { AppDialog } from "../dialogs/AppDialog";
import { Check, ChevronDown, Search, X } from "../icons";

type TargetOption = { target: ContinualLearningResponseTarget; description: string };

export function LabEvalsUploadDialog({
  awaitingBatchIds,
  onClose,
  onToast,
  series,
  state,
  training,
}: {
  awaitingBatchIds: string[];
  onClose: () => void;
  onToast: (message: string, tone: "success" | "error" | "info") => void;
  series: ModelComparisonSeries;
  state: TrainingStateResponse;
  training: ReturnType<typeof useTraining>;
}) {
  const options = useMemo(() => modelTargetOptions(state, series), [series, state]);
  const [mode, setMode] = useState<"generate" | "captured">("generate");
  const [file, setFile] = useState<File | null>(null);
  const [targets, setTargets] = useState<ContinualLearningResponseTarget[]>(() => options.slice(0, 1).map((option) => option.target));
  const fileInput = useRef<HTMLInputElement>(null);
  const busy = training.busyAction !== null;

  async function importTasks() {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const manifests = manifestsFromJson(parsed).map((manifest) => ({
        ...manifest,
        observedAttempts: mode === "generate" ? [] : manifest.observedAttempts,
        sourceFileName: file.name,
      }));
      if (mode === "captured" && manifests.some((manifest) => !manifest.observedAttempts?.length)) {
        throw new Error("A captured-response import must include observedAttempts for at least one model.");
      }
      const batchIds: string[] = [];
      for (const manifest of manifests) {
        const result = await training.actions.importContinualLearningDailyBatch(manifest, "json_upload");
        if (result) batchIds.push(result.id);
      }
      const complete = batchIds.length === manifests.length;
      const generation = mode === "generate" && batchIds.length
        ? await training.actions.generateContinualLearningResponses({ seriesId: series.id, batchIds, targets })
        : [];
      const generationStarted = mode === "captured" || Boolean(generation);
      onToast(
        complete && generationStarted
          ? `Uploaded ${batchIds.length} task batch${batchIds.length === 1 ? "" : "es"}${mode === "generate" ? " and started response generation" : " with captured responses"}.`
          : complete
            ? `Uploaded ${batchIds.length} task batch${batchIds.length === 1 ? "" : "es"}, but response generation did not start.`
            : `Imported ${batchIds.length} of ${manifests.length} batches.`,
        complete && generationStarted ? "success" : "error",
      );
      if (complete) onClose();
    } catch (error) {
      onToast(error instanceof Error ? error.message : "The task JSON could not be imported.", "error");
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function generateExisting() {
    const result = await training.actions.generateContinualLearningResponses({ seriesId: series.id, batchIds: awaitingBatchIds, targets });
    if (!result) return;
    onToast(`Generating responses for ${result.length} existing task batch${result.length === 1 ? "" : "es"}.`, "info");
    onClose();
  }

  return <AppDialog ariaLabel="Upload tasks" backdropClassName="labs-rename-backdrop" className="labs-rename-dialog labs-evals-upload-dialog" dismissDisabled={busy} onClose={onClose}>
    <header><div><h2>Upload tasks</h2><p>Import tasks alone or with model responses captured elsewhere.</p></div><button aria-label="Close upload tasks" disabled={busy} type="button" onClick={onClose}><X size={16} /></button></header>
    <form onSubmit={(event) => { event.preventDefault(); void importTasks(); }}>
      <label><span>Import</span><select value={mode} onChange={(event) => setMode(event.currentTarget.value === "captured" ? "captured" : "generate")}><option value="generate">Tasks to run</option><option value="captured">Tasks with responses</option></select></label>
      {mode === "generate" ? <ModelTargetMultiSelect options={options} value={targets} onChange={setTargets} /> : <p className="labs-detail-copy">Each observed attempt must identify the captured model, response content, and any available scores.</p>}
      <label><span>Task JSON</span><input ref={fileInput} accept="application/json,.json" type="file" onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)} /></label>
      <footer>
        <button disabled={busy} type="button" onClick={onClose}>Cancel</button>
        {mode === "generate" && awaitingBatchIds.length ? <button disabled={busy || !targets.length} type="button" onClick={() => void generateExisting()}>Run existing tasks</button> : null}
        <button disabled={busy || !file || (mode === "generate" && !targets.length)} type="submit">Upload tasks</button>
      </footer>
    </form>
  </AppDialog>;
}

function ModelTargetMultiSelect({ options, value, onChange }: { options: TargetOption[]; value: ContinualLearningResponseTarget[]; onChange: (value: ContinualLearningResponseTarget[]) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const selected = new Set(value.map(targetKey));
  const visible = options.filter((option) => `${option.target.label} ${option.description}`.toLowerCase().includes(query.trim().toLowerCase()));

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  function toggle(target: ContinualLearningResponseTarget) {
    const key = targetKey(target);
    onChange(selected.has(key) ? value.filter((candidate) => targetKey(candidate) !== key) : [...value, target]);
  }

  return <div className="labs-evals-model-field"><span>Models</span><div className="labs-evals-model-select" ref={root}>
    <button aria-expanded={open} aria-haspopup="listbox" className="labs-evals-model-trigger" type="button" onClick={() => setOpen((current) => !current)}><span>{value.length ? `${value.length} model${value.length === 1 ? "" : "s"} selected` : "Select models"}</span><ChevronDown size={14} /></button>
    {open ? <div className="labs-evals-model-menu">
      <label className="labs-evals-model-search"><Search size={13} /><input autoFocus aria-label="Search models" placeholder="Search models" value={query} onChange={(event) => setQuery(event.currentTarget.value)} /></label>
      <div aria-multiselectable="true" className="labs-evals-model-options" role="listbox">{visible.map((option) => {
        const checked = selected.has(targetKey(option.target));
        return <button aria-selected={checked} className={checked ? "selected" : undefined} key={targetKey(option.target)} role="option" type="button" onClick={() => toggle(option.target)}><span className="labs-evals-model-check">{checked ? <Check size={12} /> : null}</span><span><strong>{option.target.label}</strong><small>{option.description}</small></span></button>;
      })}{!visible.length ? <p>No matching models</p> : null}</div>
    </div> : null}
  </div></div>;
}

function modelTargetOptions(state: TrainingStateResponse, series: ModelComparisonSeries): TargetOption[] {
  const entries = new Map(state.comparisonSeriesEntries.filter((entry) => entry.seriesId === series.id).map((entry) => [entry.id, entry]));
  const versions = state.modelVersions
    .filter((version) => version.modelId === series.modelProjectId && version.status === "available" && version.comparisonSeriesEntry && entries.has(version.comparisonSeriesEntry.entryId))
    .sort((left, right) => right.version - left.version)
    .map((version) => {
      const entry = entries.get(version.comparisonSeriesEntry!.entryId)!;
      return { target: { kind: "model_version" as const, id: version.id, label: `Version ${version.version} · ${entry.label}` }, description: version.id };
    });
  return [
    ...versions,
    { target: { kind: "base_model" as const, id: series.baseModel.id, revision: series.baseModel.revision, label: series.baseModel.id }, description: `Revision ${series.baseModel.revision.slice(0, 12)}` },
  ];
}

function manifestsFromJson(value: unknown): ContinualLearningDailyBatchManifest[] {
  if (Array.isArray(value)) return value as ContinualLearningDailyBatchManifest[];
  if (value && typeof value === "object" && "batches" in value && Array.isArray((value as { batches: unknown }).batches)) return (value as { batches: ContinualLearningDailyBatchManifest[] }).batches;
  return [value as ContinualLearningDailyBatchManifest];
}
function targetKey(target: ContinualLearningResponseTarget): string { return `${target.kind}:${target.id}`; }
