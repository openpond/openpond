import { useEffect, useMemo, useRef, useState } from "react";
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
  hostedApiOrigin,
  items,
  loading,
  runs,
  state,
  training,
  onCompare,
  onPulled,
  onOpened,
  onSelect,
  onOpenRun,
  onUseModel,
  onConfigure,
}: {
  activeProfileId: string;
  hostedScope: string | null;
  hostedApiOrigin: string | null;
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
  onOpenRun: (modelId: string, runKey: string) => void;
  onOpened: (id: string) => void;
  onUseModel: (modelId: string) => void;
  onConfigure: (modelId: string) => void;
}) {
  const listHostedModelProjects = training.actions.listHostedModelProjects;
  const opening = useRef(false);
  const liveScope = useRef(hostedScope);
  liveScope.current = hostedScope;
  useEffect(() => {
    liveScope.current = hostedScope;
    return () => { liveScope.current = null; };
  }, [hostedScope]);
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
    const hostedProjects = hostedCatalog?.projects ?? [];
    const linkedByLocalId = new Map(hostedProjects.flatMap((item) =>
      item.localProjectId && item.localState !== "local_conflict" && item.localState !== "not_pulled"
        ? [[item.localProjectId, item] as const] : [],
    ));
    const linkedHostedIds = new Set(items.flatMap((item) => {
      const linked = linkedByLocalId.get(item.id);
      return linked ? [linked.project.id] : [];
    }));
    return [
      ...items.map((item) => {
        const hosted = linkedByLocalId.get(item.id) ?? null;
        const hostedUpdatedAt = hosted?.project.updatedAt ?? "";
        return { key: item.key, local: item, hosted, updatedAt: hostedUpdatedAt > item.updatedAt ? hostedUpdatedAt : item.updatedAt };
      }),
      ...hostedProjects
        .filter((item) => !linkedHostedIds.has(item.project.id))
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
  const visiblePage = Math.min(page, Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)));
  const visible = filtered.slice((visiblePage - 1) * PAGE_SIZE, visiblePage * PAGE_SIZE);
  const emptyMessage = rows.length
    ? "No Models match this Profile or search."
    : "No local or hosted Model Projects were found.";
  const loadingHosted =
    training.busyAction === "list-hosted-model-projects";
  const [hostedErrorScope, setHostedErrorScope] = useState<string | null>(null);

  useEffect(() => {
    if (!hostedScope) return;
    let cancelled = false;
    void (async () => {
      const cached = await listHostedModelProjects();
      if (cancelled) return;
      if (cached) setHostedResult({ scope: hostedScope, catalog: cached });
      setHostedErrorScope(cached ? null : hostedScope);
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

  async function retryHosted() {
    if (!hostedScope || loadingHosted) return;
    const catalog = await listHostedModelProjects({ refresh: true });
    if (liveScope.current !== hostedScope) return;
    setHostedErrorScope(catalog ? null : hostedScope);
    if (catalog) setHostedResult({ scope: hostedScope, catalog });
  }

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
    if (catalog && hostedScope && liveScope.current === hostedScope) setHostedResult({ scope: hostedScope, catalog });
  }

  async function selectModel(key: string) {
    const row = rows.find(item => item.key === key);
    if (row?.local) { onSelect(key); return; }
    if (!row?.hosted || !hostedCatalog || !hostedApiOrigin || opening.current) return;
    opening.current = true;
    try {
      const result = await training.actions.openHostedModelProject(row.hosted.project.id, hostedCatalog.teamId, hostedApiOrigin);
      if (result && liveScope.current === hostedScope) onOpened(result.project.id);
    } finally { opening.current = false; }
  }

  return (
    <div className="labs-flat-body labs-models-page">
      <ModelProjectPageHeader
        title="Models"
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
          {hostedScope && hostedErrorScope === hostedScope ? (
            <button type="button" className="training-button secondary" disabled={loadingHosted}
              onClick={() => void retryHosted()}>Retry hosted Models</button>
          ) : null}
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
        onSelect={(key) => { void selectModel(key); }}
        onOpenRun={onOpenRun}
        onUseModel={onUseModel}
        onConfigure={onConfigure}
      />
      <Pagination page={visiblePage} total={filtered.length} onChange={setPage} />
    </div>
  );
}
