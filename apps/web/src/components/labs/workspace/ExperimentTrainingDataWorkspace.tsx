import { lazy, Suspense, useState, type RefObject } from "react";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import type { TaskBatch } from "openpond-sdk/learning";
import { DropdownSelect } from "../../DropdownSelect";
import { PageChromeBoundary } from "../../app-shell/PageChrome";
import {
  DraftNavigationBoundary,
  type DraftNavigationBoundaryHandle,
} from "../DraftNavigationBoundary";
import { LearningTaskFormatsPage } from "../learning/LearningTaskFormatsPage";
import { LearningReviewPage } from "../learning/LearningReviewPage";
import { LearningBatchesPage } from "../learning/LearningBatchesPage";
import { WorkspacePanel } from "./WorkspacePanel";
import { useWorkspaceLearningClient } from "./useWorkspaceLearningClient";
import type { WorkspaceApi } from "./workspace-api";
import { learningQueryScope } from "../../../lib/query-scope";

const DatasetReviewImport = lazy(() => import("./DatasetReviewImport"));
type View = "dataset" | "formats" | "review" | "batches";
export default function ExperimentTrainingDataWorkspace({
  api,
  method,
  onClose,
  onUseBatch,
  navigation,
  beforeImport,
}: {
  api: WorkspaceApi;
  method: "sft" | "grpo" | "engram_adapter" | "decision_model" | "alphaedit" | "selective_neuron_training";
  beforeImport?: () => Promise<void>;
  onClose(): void;
  onUseBatch(batch: TaskBatch): Promise<void>;
  navigation: RefObject<DraftNavigationBoundaryHandle | null>;
}) {
  const client = useWorkspaceLearningClient(api);
  const queries = useQueryClient();
  const queryKey = learningQueryScope(client);
  const fetching = useIsFetching({ queryKey });
  const readingDatasets = useIsFetching({ queryKey: ["evaluation-workspace", api.key] });
  const [view, setView] = useState<View>("dataset");
  const [selected, setSelected] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [after, setAfter] = useState<string | null>(null);
  const change = (action: () => void) => {
    void navigation.current?.requestLeave(action);
  };
  const open = (next: View, id: string | null = null, source: string | null = null) =>
    change(() => {
      setView(next);
      setSelected(id);
      setSourceId(source);
      setAfter(null);
    });
  const close = () => change(onClose);
  return (
    <WorkspacePanel label="Experiment training data" action="experiment" onRequestClose={close}>
      <header className="experiment-training-data-header">
        <h2>Training data</h2>
        <button
          type="button"
          disabled={fetching + readingDatasets > 0}
          onClick={() => {
            void Promise.all([
              queries.invalidateQueries({ queryKey }),
              queries.invalidateQueries({ queryKey: ["evaluation-workspace", api.key] }),
            ]);
          }}
        >
          Refresh
        </button>
        <button type="button" onClick={close}>
          Back to experiment
        </button>
      </header>
      <p>
        Import a Dataset or example records, review them, then select a sealed batch. Your
        experiment settings stay open.
      </p>
      <label>
        View
        <DropdownSelect
          floating
          label="Training data view"
          value={view}
          onChange={(value) => open(value as View)}
          options={[
            { value: "dataset", label: "Published Dataset" },
            { value: "formats", label: "Import examples" },
            { value: "review", label: "Review examples" },
            { value: "batches", label: "Reviewed batches" },
          ]}
        />
      </label>
      <DraftNavigationBoundary handle={navigation}>
        <div className="experiment-training-data-workspace">
          <PageChromeBoundary>
            {view === "dataset" ? (
              <Suspense fallback={<p role="status">Opening Dataset import…</p>}>
                <DatasetReviewImport
                  api={api}
                  client={client}
                  method={method}
                  beforeImport={beforeImport}
                  navigation={navigation}
                  onImported={(receipt) => open("review", null, receipt.source.id)}
                />
              </Suspense>
            ) : view === "formats" ? (
              <LearningTaskFormatsPage
                client={client}
                selectedId={selected}
                after={after}
                allowCredentials={false}
                onSelect={(id) => open("formats", id)}
                onPage={(cursor) => change(() => setAfter(cursor))}
                onReview={(id) => open("review", id)}
              />
            ) : view === "review" ? (
              <LearningReviewPage
                client={client}
                selectedId={selected}
                sourceId={sourceId}
                onClearSource={() => open("review")}
                after={after}
                onSelect={(id) => open("review", id, sourceId)}
                onPage={(cursor) => change(() => setAfter(cursor))}
                onBatches={() => open("batches")}
              />
            ) : (
              <LearningBatchesPage
                client={client}
                selectedId={selected}
                after={after}
                purpose={method !== "grpo" ? "supervised_training" : "reward_training"}
                onSelect={(id) => open("batches", id)}
                onPage={(cursor) => change(() => setAfter(cursor))}
                onUseBatch={onUseBatch}
              />
            )}
          </PageChromeBoundary>
        </div>
      </DraftNavigationBoundary>
    </WorkspacePanel>
  );
}
