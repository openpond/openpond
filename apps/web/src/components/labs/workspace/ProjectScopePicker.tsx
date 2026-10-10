import { useState } from "react";
import { DropdownSelect } from "../../DropdownSelect";
import type { Inventory, WorkspaceApi } from "./workspace-api";

const MORE = "\u0000more-projects";

export function ProjectScopePicker({
  api,
  page,
  selectedId,
  onChange,
}: {
  api: WorkspaceApi;
  page: Inventory["projects"] | undefined;
  selectedId: string | null;
  onChange: (id: string | null) => void;
}) {
  const [additional, setAdditional] = useState<Inventory["projects"][]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projects = [
    ...new Map(
      [...(page?.projects ?? []), ...additional.flatMap((value) => value.projects)].map(
        (project) => [project.id, project],
      ),
    ).values(),
  ].filter((project) => !project.archived);
  const cursor = additional.length ? additional.at(-1)!.nextCursor : page?.nextCursor;
  async function loadMore() {
    if (!cursor || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.request<Inventory["projects"]>("projects", { cursor });
      setAdditional((pages) => [...pages, next]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <DropdownSelect
        className="evaluation-scope-select"
        label="Project"
        searchable={projects.length > 8}
        value={selectedId ?? ""}
        options={[
          { value: "", label: "All projects" },
          ...(selectedId && !projects.some((project) => project.id === selectedId)
            ? [{ value: selectedId, label: "Unavailable project" }]
            : []),
          ...projects.map((project) => ({ value: project.id, label: project.content.name })),
          ...(cursor
            ? [
                {
                  value: MORE,
                  label: busy ? "Loading projects…" : "Load more projects",
                  separatorBefore: true,
                  disabled: busy,
                },
              ]
            : []),
        ]}
        onChange={(value) => (value === MORE ? void loadMore() : onChange(value || null))}
      />
      {error ? (
        <span className="evaluation-scope-error" role="alert" title={error}>
          Projects unavailable
        </span>
      ) : null}
    </>
  );
}
