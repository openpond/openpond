import { useEffect, useMemo, useState } from "react";
import type {
  CreateImproveRun,
  TrainingStateResponse,
} from "@openpond/contracts";

import { Search } from "../icons";
import { DropdownSelect } from "../DropdownSelect";
import type { useTraining } from "../../hooks/useTraining";
import type { HostedModelProjectCatalog } from "../../hooks/hosted-model-project-types";
import type { LabWorkproductSummary } from "./lab-workproducts";
import {
  ModelsTable,
  Pagination,
  type ModelTableRow,
} from "./LabsRouteSections";
import { ModelProjectPageHeader } from "./ModelProjectPageHeader";

const PAGE_SIZE = 10;

export function LabModelsPage({
  activeProfileId,
  hostedScope,
  items,
  loading,
  runs,
  state,
  training,
  onCompare,
  onPulled,
  onSelect,
  onUseModel,
}: {
  activeProfileId: string;
  hostedScope: string | null;
  items: LabWorkproductSummary[];
  loading: boolean;
  runs: CreateImproveRun[];
  state: TrainingStateResponse | null;
  training: ReturnType<typeof useTraining>;
  onCompare: () => void;
  onPulled: (
    projectId: string,
    projectName: string,
    importedJobCount: number,
    importedMetricCount: number,
  ) => void;
  onSelect: (key: string) => void;
  onUseModel: (modelId: string) => void;
}) {
  const listHostedModelProjects = training.actions.listHostedModelProjects;
  const [profileId, setProfileId] = useState("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [hostedResult, setHostedResult] = useState<{ scope: string; catalog: HostedModelProjectCatalog } | null>(null);
  const hostedCatalog = hostedResult?.scope === hostedScope ? hostedResult.catalog : null;
  const comparableRunCount = state?.modelRuns.filter(
    (run) => run.receipt?.schemaVersion === "openpond.modelEvaluationReceipt.v1",
  ).length ?? 0;
  const profileIds = useMemo(
    () =>
      [...new Set(
        items.flatMap((item) =>
          item.ownerProfileId ? [item.ownerProfileId] : [],
        ),
      )].sort((left, right) => {
        if (left === activeProfileId) return -1;
        if (right === activeProfileId) return 1;
        return left.localeCompare(right);
      }),
    [activeProfileId, items],
  );
  const rows = useMemo<ModelTableRow[]>(() => {
    const hostedByPortableId = new Map(
      (hostedCatalog?.projects ?? []).map(
        (item) => [item.project.portableProjectId, item] as const,
      ),
    );
    const localIds = new Set(items.map((item) => item.id));
    return [
      ...items.map((item) => ({
        key: item.key,
        local: item,
        hosted: hostedByPortableId.get(item.id) ?? null,
        updatedAt:
          hostedByPortableId.get(item.id)?.project.updatedAt ?? item.updatedAt,
      })),
      ...(hostedCatalog?.projects ?? [])
        .filter((item) => !localIds.has(item.project.portableProjectId))
        .map((hosted) => ({
          key: `hosted:${hosted.project.id}`,
          local: null,
          hosted,
          updatedAt: hosted.project.updatedAt,
        })),
    ];
  }, [hostedCatalog?.projects, items]);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return rows
      .filter((row) => {
        if (
          profileId !== "all" &&
          row.local?.ownerProfileId !== profileId
        ) {
          return false;
        }
        const project = row.hosted?.project;
        return (
          !normalized
          || [
            row.local?.name ?? project?.name ?? "",
            row.local?.description ?? project?.objective ?? "",
            row.local?.id ?? project?.portableProjectId ?? "",
            row.local?.ownerProfileId ?? "",
          ]
            .some((value) => value.toLowerCase().includes(normalized))
        );
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }, [profileId, query, rows]);
  const visible = filtered.slice(
    (page - 1) * PAGE_SIZE,
    page * PAGE_SIZE,
  );
  const emptyMessage = rows.length
    ? "No Models match this Profile or search."
    : "No local or hosted Model Projects were found.";
  const loadingHosted =
    training.busyAction === "list-hosted-model-projects";

  useEffect(() => {
    if (!hostedScope) return;
    let cancelled = false;
    void (async () => {
      const cached = await listHostedModelProjects();
      if (!cancelled && cached) setHostedResult({ scope: hostedScope, catalog: cached });
      if (!cached?.cached) return;
      const refreshed = await listHostedModelProjects({
        refresh: true,
        silent: true,
      });
      if (!cancelled && refreshed) setHostedResult({ scope: hostedScope, catalog: refreshed });
    })();
    return () => {
      cancelled = true;
    };
  }, [listHostedModelProjects, hostedScope]);

  async function pullHostedProject(
    item: HostedModelProjectCatalog["projects"][number],
  ) {
    const result = await training.actions.pullHostedModelProject(
      item.project.id,
    );
    if (!result) return;
    onPulled(
      result.project.id,
      result.project.name,
      result.importedJobCount,
      result.importedMetricCount,
    );
    const catalog = await listHostedModelProjects({ silent: true });
    if (catalog && hostedScope) setHostedResult({ scope: hostedScope, catalog });
  }

  return (
    <div className="labs-flat-body labs-models-page">
      <ModelProjectPageHeader
        title="Models"
        description="Compose Tasksets and scorers, run training and evaluations, and manage deployable Model Versions."
        metrics={[
          { label: "Projects", value: rows.length },
          {
            label: "Hosted",
            value: hostedCatalog?.projects.length ?? "—",
            hint: hostedCatalog ? `Team ${hostedCatalog.teamId}` : hostedScope ? "Loading active team" : "Sign in to load hosted models",
          },
          { label: "Evaluation receipts", value: comparableRunCount },
          { label: "Profiles", value: profileIds.length },
        ]}
      />
      <div className="labs-workproduct-toolbar">
        <label className="labs-search">
          <Search size={14} />
          <input
            aria-label="Search Models"
            placeholder="Search Models"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
          />
        </label>
        <div className="labs-model-toolbar-actions">
          <DropdownSelect
            className="labs-model-profile-filter"
            label="Filter Models by Profile"
            value={profileId}
            options={[
              { value: "all", label: "All profiles" },
              ...profileIds.map((candidate) => ({
                value: candidate,
                label: `${candidate}${candidate === activeProfileId ? " (active)" : ""}`,
              })),
            ]}
            onChange={(value) => {
              setProfileId(value);
              setPage(1);
            }}
          />
          <button
            className="training-button secondary"
            disabled={comparableRunCount < 1}
            type="button"
            onClick={onCompare}
          >
            Compare runs
          </button>
        </div>
      </div>
      <ModelsTable
        busyAction={training.busyAction}
        emptyMessage={emptyMessage}
        rows={visible}
        loading={loading || (loadingHosted && !hostedCatalog && !items.length)}
        runs={runs}
        state={state}
        onPull={(item) => void pullHostedProject(item)}
        onSelect={onSelect}
        onUseModel={onUseModel}
      />
      <Pagination page={page} total={filtered.length} onChange={setPage} />
    </div>
  );
}
