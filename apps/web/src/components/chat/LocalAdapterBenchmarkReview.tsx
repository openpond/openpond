import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ChatResourceSummary } from "@openpond/contracts";
import type { LocalAdapterBenchmarkSetup } from "openpond-sdk/training";
import type { ClientConnection } from "../../api";
import { chatResourceRequest } from "../../api/chat-resource-api";
import { useErrorToast } from "../../app/AppToastContext";
import { connectionQueryScope } from "../../lib/query-scope";
import { DropdownSelect } from "../DropdownSelect";
import { ChatResourceSummary as BenchmarkResult } from "./ChatResourceSummary";

type Setup = LocalAdapterBenchmarkSetup;
type Editable = Partial<Omit<Setup, "candidate">> & { name?: string };
type Review = {
  draftId: string;
  revision: number;
  name: string;
  candidate: Setup["candidate"];
  candidateLabel: string;
  setup: Setup | null;
  datasets: ChatResourceSummary[];
  baselines: Array<{ label: string; source: Setup["candidate"] }>;
  results: ChatResourceSummary[];
};
type Command = { operation: "inspect" } |
  { operation: "review"; operationId: string; revision: number; name: string; setup: Setup } |
  { operation: "start"; operationId: string; revision: number };
type Comparison = { comparable: boolean; reasons: string[]; metrics: Array<{
  feedbackKey: string; eligibleCount: number; baseline: number | null; candidate: number | null; delta: number | null;
}> };

function datasetKey(value: { id: string; revision: number }) { return JSON.stringify([value.id, value.revision]); }

export function LocalAdapterBenchmarkReview({ connection, sessionId, initial, onReviewed }: {
  connection: ClientConnection;
  sessionId: string;
  initial?: Editable;
  onReviewed?(setup: Setup, name: string, baselineLabel: string | undefined): void;
}) {
  const cache = useQueryClient();
  const [edits, setEdits] = useState<Editable | null>(null);
  const startId = useRef<string | null>(null);
  const reviewId = useRef<string | null>(null);
  const key = ["local-adapter-benchmark", connectionQueryScope(connection), sessionId] as const;
  const request = <T,>(input: Command) => chatResourceRequest<T>(connection, "experiment", {
    action: "local_adapter_benchmark", payload: { ...input, sessionId },
  });
  const query = useQuery({
    queryKey: key, queryFn: () => request<Review>({ operation: "inspect" }), retry: false,
    refetchInterval: query => query.state.data?.results.some(result => ["queued", "running", "cancelling"].includes(result.state)) ? 1_500 : false,
  });
  const save = useMutation({
    mutationFn: (input: Extract<Command, { operation: "review" }>) => request<{ revision: number }>(input),
    onSuccess: async ({ revision }, input) => {
      reviewId.current = null;
      startId.current = null;
      cache.setQueryData<Review>(key, current => current && { ...current, revision, name: input.name, setup: input.setup });
      setEdits(null);
      const baseline = query.data?.baselines.find(option => option.source.versionId === input.setup.baseline?.versionId);
      onReviewed?.(input.setup, input.name, baseline?.label);
    },
  });
  const start = useMutation({
    mutationFn: (input: Extract<Command, { operation: "start" }>) => request<{ summaries: ChatResourceSummary[]; errors: Array<{ message: string }> }>(input),
    onSuccess: async () => {
      startId.current = null;
      await cache.invalidateQueries({ queryKey: key });
    },
  });
  const compare = useMutation({
    mutationFn: ({ baselineId, candidateId }: { baselineId: string; candidateId: string }) =>
      chatResourceRequest<{ comparison: Comparison }>(connection, "experiment", { action: "compare", payload: { baselineId, candidateId } }),
  });
  useErrorToast(save.error ?? start.error ?? query.error ?? compare.error ?? start.data?.errors[0]?.message);
  const review = query.data;
  if (!review) return query.isPending ? <p role="status">Loading saved Model Version…</p>
    : <button type="button" className="training-button secondary" onClick={() => void query.refetch()}>Reload Model Version</button>;
  const current = { name: review.name, ...(review.setup ?? initial), ...edits };
  const name = current.name ?? review.name;
  const split = current.split ?? "validation";
  const samples = current.samples ?? 10;
  const tokens = current.maxOutputTokens ?? 128;
  const seed = current.seed ?? 0;
  const device = current.device ?? "cpu";
  const busy = save.isPending || start.isPending;
  const active = review.results.some(result => ["queued", "running", "cancelling"].includes(result.state));
  const reviewed = Boolean(review.setup && !edits);
  const completed = review.results.filter(result => result.state === "completed" && result.benchmark?.revision === review.revision);
  const baseline = review.setup?.baseline && completed.find(result => result.model === `local-sft-adapter/${review.setup!.baseline!.versionId}`);
  const candidate = completed.find(result => result.model === `local-sft-adapter/${review.candidate.versionId}` &&
    result.benchmark?.setupHash === baseline?.benchmark?.setupHash);
  const comparison = compare.variables?.baselineId === baseline?.id && compare.variables?.candidateId === candidate?.id ? compare.data?.comparison : undefined;
  const selectedDataset = current.dataset && datasetKey(current.dataset);
  const datasets = review.datasets.flatMap(item => item.evaluationHash ? [{
    value: datasetKey(item), label: `${item.name} revision ${item.revision}`,
  }] : []);
  if (selectedDataset && !datasets.some(option => option.value === selectedDataset))
    datasets.push({ value: selectedDataset, label: `Saved Dataset revision ${current.dataset!.revision}` });
  const numeric = <K extends "samples" | "maxOutputTokens" | "seed">(field: K, label: string, value: number, min: number, max: number) =>
    <label className="resource-setup-input">{label}<input type="number" min={min} max={max}
      value={Number.isFinite(value) ? value : ""} disabled={busy} onChange={event => change({ [field]: event.target.valueAsNumber })} /></label>;
  function change(patch: Editable) {
    reviewId.current = null;
    setEdits(previous => ({ ...previous, ...patch }));
  }
  return <section className="resource-setup-fields" aria-label="Saved Model Benchmark review">
    <div className="resource-setup-input">
      <strong>{review.candidateLabel}</strong>
      <span>Candidate adapter runs on this device with the Dataset’s local graders.</span>
    </div>
    <label className="resource-setup-input">Benchmark name<input value={name} disabled={busy}
      onChange={event => change({ name: event.target.value })} /></label>
    <DropdownSelect label="Benchmark Dataset revision" value={selectedDataset ?? ""} disabled={busy} searchable
      options={[{ value: "", label: "Choose a Dataset revision" }, ...datasets]}
      onChange={key => {
        const item = review.datasets.find(item => datasetKey(item) === key);
        change({ dataset: item?.evaluationHash ? { id: item.id, revision: item.revision, contentHash: item.evaluationHash } : undefined });
      }} />
    <DropdownSelect label="Saved Model baseline" value={current.baseline?.versionId ?? ""} disabled={busy} searchable
      options={[{ value: "", label: "No baseline" }, ...review.baselines.map(option => ({ value: option.source.versionId, label: option.label }))]}
      onChange={key => change({ baseline: review.baselines.find(option => option.source.versionId === key)?.source })} />
    <DropdownSelect label="Benchmark Dataset split" value={split} disabled={busy}
      options={[{ value: "train", label: "Train" }, { value: "validation", label: "Validation" }, { value: "test", label: "Test" }, { value: "frozen_eval", label: "Frozen evaluation" }]}
      onChange={value => change({ split: value as Setup["split"] })} />
    <DropdownSelect label="Benchmark device" value={device} disabled={busy}
      options={[{ value: "cpu", label: "CPU" }, { value: "cuda", label: "NVIDIA CUDA" }]}
      onChange={value => change({ device: value as Setup["device"] })} />
    {numeric("samples", "Maximum cases", samples, 1, 100)}
    {numeric("maxOutputTokens", "Maximum output tokens", tokens, 1, 2048)}
    {numeric("seed", "Seed", seed, 0, 2_147_483_647)}
    <div className="resource-setup-presets">
      <button type="button" className="training-button secondary" disabled={busy || !current.dataset || !name.trim() ||
        !Number.isInteger(samples) || samples < 1 || samples > 100 || !Number.isInteger(tokens) || tokens < 1 || tokens > 2048 ||
        !Number.isInteger(seed) || seed < 0 || seed > 2_147_483_647} onClick={() => {
          const operationId = reviewId.current ??= crypto.randomUUID();
          save.mutate({ operation: "review", revision: review.revision, operationId, name, setup: {
            candidate: review.candidate, baseline: current.baseline, dataset: current.dataset!, device, split, samples, seed, maxOutputTokens: tokens,
          } });
        }}>{save.isPending ? "Saving review" : "Save Benchmark review"}</button>
      <button type="button" className="training-button" disabled={busy || !reviewed || active} onClick={() => {
        const operationId = startId.current ??= crypto.randomUUID();
        start.mutate({ operation: "start", revision: review.revision, operationId });
      }}>{start.isPending ? "Starting Benchmark" : "Run saved Benchmark"}</button>
      {reviewed ? <span>Reviewed revision {review.revision}</span> : null}
    </div>
    {baseline && candidate ? <button type="button" className="training-button secondary" disabled={compare.isPending}
      onClick={() => compare.mutate({ baselineId: baseline.id, candidateId: candidate.id })}>Compare saved versions</button> : null}
    {comparison?.comparable ? <table className="training-data-table" aria-label="Matched version scores">
      <thead><tr><th>Metric</th><th>Cases</th><th>Baseline</th><th>Candidate</th><th>Change</th></tr></thead>
      <tbody>{comparison.metrics.map(metric => <tr key={metric.feedbackKey}>
        <td>{metric.feedbackKey}</td><td>{metric.eligibleCount}</td><td>{metric.baseline?.toFixed(3) ?? "Unavailable"}</td>
        <td>{metric.candidate?.toFixed(3) ?? "Unavailable"}</td><td>{metric.delta?.toFixed(3) ?? "Unavailable"}</td>
      </tr>)}</tbody>
    </table> : comparison?.reasons.length ? <p>{comparison.reasons.join(" ")}</p> : null}
    {review.results.map(result => <BenchmarkResult key={result.id} connection={connection} initial={result} />)}
  </section>;
}
