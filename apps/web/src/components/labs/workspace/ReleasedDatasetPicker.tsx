import { DropdownSelect } from "../../DropdownSelect";
import { ErrorToast } from "../../common/ErrorToast";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  HostedTasksetSummary,
  TasksetCatalogPage,
  TasksetCatalogReleaseRefSchema,
} from "openpond-sdk/taskset-catalog";
import type { z } from "zod";
import type { WorkspaceApi } from "./workspace-api";
type LocalChoice = {
  id: string;
  name: string;
  taskset: { id: string; revision: number; contentHash: string };
  taskCount: number;
};
type Release = z.infer<typeof TasksetCatalogReleaseRefSchema>;
const identity = (release: Release) => JSON.stringify([release.id, release.revision, release.contentHash]);

export function ReleasedDatasetPicker({
  api,
  value,
  onChange,
  disabled,
  localChoices = [],
  localLoading = false,
}: {
  localChoices?: LocalChoice[];
  localLoading?: boolean;
  api: WorkspaceApi;
  value: Release | null;
  onChange: (value: Release | null) => void;
  disabled: boolean;
}) {
  const [afterId, setAfter] = useState<string | undefined>();
  const page = useQuery({
    queryKey: ["evaluation-workspace", api.key, "released-dataset-picker", afterId],
    queryFn: ({ signal }) =>
      api.request<TasksetCatalogPage>(
        "catalogDatasets",
        { limit: 100, ...(afterId ? { afterId } : {}) },
        signal,
      ),
  });
  const localChoice = localChoices.find(
    (item) => value !== null && identity(item.taskset) === identity(value),
  );
  const selected = useQuery({
    queryKey: ["evaluation-workspace", api.key, "resolveDataset", value?.contentHash],
    enabled: Boolean(value) && !localChoice && !localLoading,
    queryFn: ({ signal }) =>
      api.request<HostedTasksetSummary>("resolveDataset", { release: value }, signal),
  });
  const choices = [
    ...localChoices.map((item) => ({
      id: item.id,
      name: item.name,
      release: item.taskset,
      taskCount: item.taskCount,
    })),
    ...(selected.data ? [selected.data] : []),
    ...(page.data?.items ?? []),
  ].filter(
    (item, index, items) =>
      items.findIndex((other) => identity(other.release) === identity(item.release)) === index,
  );
  return (
    <section>
      <label>
        Dataset version
        <DropdownSelect
          label="Dataset version"
          floating
          searchable
          disabled={disabled}
          value={value ? identity(value) : ""}
          options={[
            { value: "", label: "Choose a published dataset" },
            ...(value && !choices.some(item => identity(item.release) === identity(value))
              ? [{ value: identity(value), label: `${value.id} / Revision ${value.revision}`, disabled: true }]
              : []),
            ...choices.map((item) => ({
              value: identity(item.release),
              label: `${item.name} / Revision ${item.release.revision} / ${item.taskCount} tasks`,
            })),
          ]}
          onChange={(value) =>
            onChange(choices.find((item) => identity(item.release) === value)?.release ?? null)
          }
        />
      </label>
      {(page.error ?? selected.error) ? <ErrorToast error={page.error ?? selected.error} /> : null}
      {afterId ? (
        <button type="button" onClick={() => setAfter(undefined)}>
          First dataset page
        </button>
      ) : null}
      {page.data?.nextCursor ? (
        <button type="button" onClick={() => setAfter(page.data!.nextCursor!)}>
          More dataset versions
        </button>
      ) : null}
      {value ? (
        <details>
          <summary>Exact Dataset release</summary>
          <p>
            {value.id} / Revision {value.revision}
          </p>
          <code>{value.contentHash}</code>
        </details>
      ) : null}
    </section>
  );
}
