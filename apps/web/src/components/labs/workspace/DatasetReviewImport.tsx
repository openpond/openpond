import { useState, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { canonicalJson } from "openpond-sdk/training";
import {
  DatasetTrainingReviewSourceSchema,
  type DatasetTrainingReviewReceipt,
} from "openpond-sdk/taskset-packages";
import type { OpenPondLearningClient } from "openpond-sdk/learning";
import { ErrorToast } from "../../common/ErrorToast";
import type { DraftNavigationBoundaryHandle } from "../DraftNavigationBoundary";
import { connectionQueryScope } from "../../../lib/query-scope";
import { ReleasedDatasetPicker } from "./ReleasedDatasetPicker";
import { useDatasetPopulation } from "./useDatasetPopulation";
import { useEvaluationSetup, type DatasetRelease } from "./EvaluationSetupState";
import { DatasetReviewImportForm } from "./DatasetReviewImportForm";
import type { WorkspaceApi } from "./workspace-api";

export default function DatasetReviewImport({
  api,
  client,
  method,
  beforeImport,
  navigation,
  onImported,
}: {
  api: WorkspaceApi;
  client: OpenPondLearningClient;
  method: "sft" | "grpo" | "engram_adapter" | "decision_model" | "alphaedit" | "selective_neuron_training";
  beforeImport?: () => Promise<void>;
  navigation: RefObject<DraftNavigationBoundaryHandle | null>;
  onImported(receipt: DatasetTrainingReviewReceipt): void;
}) {
  const setup = useEvaluationSetup();
  const [release, setRelease] = useState<DatasetRelease | null>(
    () => setup.selection?.release ?? setup.draft?.release ?? null,
  );
  const [locked, setLocked] = useState(false);
  const source = useQuery({
    queryKey: [
      "evaluation-workspace",
      api.key,
      connectionQueryScope(api.connection),
      "dataset-review-source",
      release,
    ],
    enabled: Boolean(release),
    queryFn: async ({ signal }) => {
      const value = DatasetTrainingReviewSourceSchema.parse(
        await api.request("datasetReviewSource", { release }, signal),
      );
      if (canonicalJson(value.dataset) !== canonicalJson(release))
        throw new Error("Dataset review returned a different release.");
      return value;
    },
  });
  const population = useDatasetPopulation(api, release);
  const mismatch =
    source.data && population.data && source.data.taskCount !== population.data.taskCount
      ? new Error("The Dataset review population differs from the retained package.")
      : null;
  const error = source.error ?? population.error ?? mismatch;
  return (
    <section className="learning-workspace">
      <h3>Import a published Dataset</h3>
      <ReleasedDatasetPicker
        api={api}
        value={release}
        disabled={locked}
        onChange={(next) => {
          if (canonicalJson(next) !== canonicalJson(release))
            void navigation.current?.requestLeave(() => setRelease(next));
        }}
      />
      <ErrorToast error={error} />
      {error ? (
        <button
          type="button"
          className="training-button secondary"
          disabled={locked}
          onClick={() => {
            void source.refetch();
            void population.refetch();
          }}
        >
          Retry Dataset read
        </button>
      ) : null}
      {release && (!source.data || !population.data) && !error ? (
        <p role="status">Reading the exact Dataset version…</p>
      ) : null}
      {source.data &&
      population.data &&
      !mismatch &&
      canonicalJson(source.data.dataset) === canonicalJson(release) ? (
        <DatasetReviewImportForm
          key={`${connectionQueryScope(api.connection)}:${source.data.dataset.contentHash}:${method}`}
          api={api}
          client={client}
          source={source.data}
          tasks={population.data.items}
          method={method}
          beforeImport={beforeImport}
          initialSelection={
            setup.selection?.release.contentHash === source.data.dataset.contentHash &&
            setup.selection.mode === "subset"
              ? setup.selection.ids
              : null
          }
          onLocked={setLocked}
          onImported={onImported}
        />
      ) : null}
    </section>
  );
}
