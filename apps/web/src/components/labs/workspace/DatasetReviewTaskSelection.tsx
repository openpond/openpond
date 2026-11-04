import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  DatasetPopulationPageSchema,
  type DatasetPopulationPage,
} from "openpond-sdk/dataset-workspaces";
import { canonicalJson } from "openpond-sdk/training";
import { DropdownSelect } from "../../DropdownSelect";
import { ErrorToast } from "../../common/ErrorToast";
import { ReadableTaskValue, taskInputSummary } from "../ReadableTaskValue";
import { connectionQueryScope } from "../../../lib/query-scope";
import type { WorkspaceApi } from "./workspace-api";

/** Reuse the experiment table geometry and checkboxes; selection here belongs
 * to the import, so it never rewrites the parent evaluation population. */
export function DatasetReviewTaskSelection({
  api,
  release,
  tasks,
  selected,
  onChange,
  disabled,
}: {
  api: WorkspaceApi;
  release: DatasetPopulationPage["release"];
  tasks: DatasetPopulationPage["items"];
  selected: string[];
  onChange(ids: string[]): void;
  disabled: boolean;
}) {
  const [page, setPage] = useState(0);
  const chosen = new Set(selected);
  const split =
    selected.length === tasks.length
      ? "all"
      : !selected.length
        ? "none"
        : (["train", "validation", "test", "frozen_eval"].find((value) =>
            tasks.every((task) => chosen.has(task.id) === (task.split === value)),
          ) ?? "custom");
  const rows = tasks.slice(page * 20, (page + 1) * 20);
  const afterId = page ? tasks[page * 20 - 1]?.id : undefined;
  const previews = useQuery({
    queryKey: [
      "evaluation-workspace",
      api.key,
      connectionQueryScope(api.connection),
      "dataset-review-preview",
      release,
      afterId,
    ],
    queryFn: async ({ signal }) => {
      const value = DatasetPopulationPageSchema.parse(
        await api.request(
          "datasetPopulation",
          {
            release,
            view: "policy",
            limit: 20,
            ...(afterId ? { afterId } : {}),
          },
          signal,
        ),
      );
      if (
        value.teamId !== api.teamId ||
        canonicalJson(value.release) !== canonicalJson(release) ||
        value.view !== "policy" ||
        canonicalJson(value.items.map((item) => item.id)) !==
          canonicalJson(rows.map((item) => item.id))
      )
        throw new Error("The example preview differs from the selected Dataset population.");
      return value;
    },
  });
  const byId = new Map(previews.data?.items.map((item) => [item.id, item]));
  return (
    <section>
      <label>
        Examples
        <DropdownSelect
          label="Dataset examples to import"
          floating
          value={split}
          disabled={disabled}
          options={[
            { value: "all", label: "All examples" },
            { value: "train", label: "Training split" },
            { value: "validation", label: "Validation split" },
            { value: "test", label: "Test split" },
            { value: "frozen_eval", label: "Frozen evaluation split" },
            { value: "none", label: "None" },
            ...(split === "custom"
              ? [{ value: "custom", label: "Custom selection", disabled: true }]
              : []),
          ]}
          onChange={(value) =>
            onChange(
              tasks
                .filter((task) => value === "all" || task.split === value)
                .map((task) => task.id),
            )
          }
        />
      </label>
      <p>
        {selected.length} of {tasks.length} examples selected. Each example keeps its original
        split.
      </p>
      <ErrorToast error={previews.error} />
      {previews.error ? (
        <button
          type="button"
          className="training-button secondary"
          onClick={() => void previews.refetch()}
        >
          Retry example previews
        </button>
      ) : null}
      <div className="training-table-wrap">
        <table className="training-data-table evaluation-workspace-table">
          <thead>
            <tr>
              <th>Select</th>
              <th>Example</th>
              <th>Split</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((task, index) => {
              const preview = byId.get(task.id);
              const input = preview && "input" in preview ? preview.input : null;
              return (
                <tr key={task.id}>
                  <td>
                    <input
                      className="training-chat-checkbox"
                      type="checkbox"
                      aria-label={`Import example ${page * 20 + index + 1}`}
                      disabled={disabled}
                      checked={chosen.has(task.id)}
                      onChange={(event) =>
                        onChange(
                          event.target.checked
                            ? [...selected, task.id]
                            : selected.filter((id) => id !== task.id),
                        )
                      }
                    />
                  </td>
                  <td className="dataset-review-example">
                    {input ? (
                      <>
                        <span>{taskInputSummary(input) || "Structured input"}</span>
                        <details>
                          <summary>Inspect input</summary>
                          <ReadableTaskValue value={input} />
                          <code>{task.id}</code>
                        </details>
                      </>
                    ) : (
                      <span>
                        {previews.isPending ? "Loading input…" : `Example ${page * 20 + index + 1}`}
                      </span>
                    )}
                  </td>
                  <td>{task.split.replaceAll("_", " ")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="model-build-actions">
        {page > 0 ? (
          <button
            type="button"
            className="training-button secondary"
            onClick={() => setPage((value) => value - 1)}
          >
            Previous examples
          </button>
        ) : null}
        {(page + 1) * 20 < tasks.length ? (
          <button
            type="button"
            className="training-button secondary"
            onClick={() => setPage((value) => value + 1)}
          >
            More examples
          </button>
        ) : null}
      </div>
    </section>
  );
}
