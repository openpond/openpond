import { useMemo, useState } from "react";
import type {
  CreateImproveRun,
  ProviderSettings,
  TrainingStateResponse,
} from "@openpond/contracts";

import { Search } from "../icons";
import { DropdownSelect } from "../DropdownSelect";
import type { LabWorkproductSummary } from "./lab-workproducts";
import { ModelsTable, Pagination } from "./LabsRouteSections";
import { LabModelComparisonDialog } from "./LabModelComparisonDialog";

const PAGE_SIZE = 10;

export function LabModelsPage({
  activeProfileId,
  items,
  loading,
  providerSettings,
  runs,
  state,
  onSelect,
  onUseModel,
}: {
  activeProfileId: string;
  items: LabWorkproductSummary[];
  loading: boolean;
  providerSettings: ProviderSettings | null;
  runs: CreateImproveRun[];
  state: TrainingStateResponse | null;
  onSelect: (key: string) => void;
  onUseModel: (modelId: string) => void;
}) {
  const [profileId, setProfileId] = useState("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [comparisonOpen, setComparisonOpen] = useState(false);
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
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return items
      .filter((item) => {
        if (profileId !== "all" && item.ownerProfileId !== profileId) {
          return false;
        }
        return (
          !normalized
          || [item.name, item.description, item.id, item.ownerProfileId ?? ""]
            .some((value) => value.toLowerCase().includes(normalized))
        );
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }, [items, profileId, query]);
  const visible = filtered.slice(
    (page - 1) * PAGE_SIZE,
    page * PAGE_SIZE,
  );
  const emptyMessage = items.length
    ? "No Models match this Profile or search."
    : "No Models exist in this workspace yet.";

  return (
    <div className="labs-flat-body labs-models-page">
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
            onClick={() => setComparisonOpen(true)}
          >
            Compare runs
          </button>
        </div>
      </div>
      <ModelsTable
        emptyMessage={emptyMessage}
        items={visible}
        loading={loading}
        runs={runs}
        state={state}
        onSelect={onSelect}
        onUseModel={onUseModel}
      />
      <Pagination page={page} total={filtered.length} onChange={setPage} />
      {comparisonOpen && state ? (
        <LabModelComparisonDialog
          items={items}
          providerSettings={providerSettings}
          state={state}
          onClose={() => setComparisonOpen(false)}
          onOpenModel={(key) => {
            setComparisonOpen(false);
            onSelect(key);
          }}
        />
      ) : null}
    </div>
  );
}
