import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ClientConnection } from "../../api/api-client";
import { chatResourceRequest, type DatasetResponse } from "../../api/chat-resource-api";
import { useAppToast, useErrorToast } from "../../app/AppToastContext";
import { connectionQueryScope } from "../../lib/query-scope";
import type { ResourceSetupDraft } from "../../lib/resource-setup-prompt";
import { DropdownSelect } from "../DropdownSelect";

type Examples = NonNullable<ResourceSetupDraft["datasetExamples"]>;
type DatasetRef = NonNullable<ResourceSetupDraft["datasetRef"]>;
type SourceRow = Record<string, unknown>;

const MAX_EXAMPLES = 50;
const MAX_EXAMPLE_TEXT = 2_000;

async function readSource(file: File): Promise<SourceRow[]> {
  if (file.size > 512 * 1024) throw new Error("Choose a JSON or JSON Lines file up to 512 KiB.");
  const text = (await file.text()).trim();
  const values: unknown = file.name.toLowerCase().endsWith(".jsonl")
    ? text
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line))
    : JSON.parse(text);
  if (
    !Array.isArray(values) ||
    !values.length ||
    values.length > MAX_EXAMPLES ||
    !values.every((row) => row && typeof row === "object" && !Array.isArray(row))
  )
    throw new Error("The file must contain between 1 and 50 example objects.");
  return values;
}

function mapSource(rows: SourceRow[], promptField: string, expectedField: string): Examples {
  return rows.map((row, index) => {
    const prompt = Object.hasOwn(row, promptField) ? row[promptField] : null;
    const expected = expectedField && Object.hasOwn(row, expectedField) ? row[expectedField] : null;
    if (typeof prompt !== "string" || !prompt.trim() || (expectedField && expected == null))
      throw new Error(`Choose fields with a prompt and an expected output on row ${index + 1}.`);
    const output =
      expected == null ? "" : typeof expected === "string" ? expected : JSON.stringify(expected);
    if (prompt.length > MAX_EXAMPLE_TEXT || output.length > MAX_EXAMPLE_TEXT)
      throw new Error(`Row ${index + 1} exceeds 2,000 characters per field.`);
    return { id: crypto.randomUUID(), prompt, expected: output };
  });
}

export function DatasetSetupReview({
  draft,
  connection,
  sessionId,
  busy,
  managedAvailable,
  activeField,
  onChange,
  onAttach,
  onBusy,
}: {
  draft: ResourceSetupDraft;
  connection: ClientConnection | null;
  sessionId: string | null;
  busy: boolean;
  managedAvailable: boolean;
  activeField: string;
  onChange(current: ResourceSetupDraft, next: ResourceSetupDraft): void;
  onAttach(reference: DatasetRef): Promise<boolean>;
  onBusy(busy: boolean): void;
}) {
  const [sourceRows, setSourceRows] = useState<SourceRow[]>([]);
  const [promptField, setPromptField] = useState("");
  const [expectedField, setExpectedField] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [page, setPage] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const showToast = useAppToast();
  const examples = draft.datasetExamples ?? [];
  const source = draft.values.source;
  const existing = source === "Use an existing dataset";
  const fileSource = source === "Import a local file";
  const reference = draft.datasetRef;
  const preview = useQuery({
    queryKey: [
      "resource-setup-dataset-preview",
      connectionQueryScope(connection),
      reference?.id,
      reference?.revision,
    ],
    enabled: Boolean(connection && reference && existing && activeField === "preview"),
    queryFn: ({ signal }) =>
      chatResourceRequest<DatasetResponse>(
        connection!,
        "dataset",
        {
          action: "read",
          id: reference!.id,
          expectedRevision: reference!.revision,
        },
        signal,
      ),
    staleTime: Infinity,
  });
  useErrorToast(error ?? preview.error);

  async function perform(action: () => Promise<void>) {
    onBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause);
    } finally {
      onBusy(false);
    }
  }

  function updateExamples(next: Examples, fields = draft.values.fields) {
    setPage(0);
    onChange(draft, {
      ...draft,
      revision: draft.revision + 1,
      datasetInputsDirty: true,
      datasetExamples: next,
      values: { ...draft.values, fields },
    });
  }

  async function attach(summary: DatasetResponse["summary"]) {
    const pinned = {
      id: summary.id,
      revision: summary.revision,
      contentHash: summary.evaluationHash,
    };
    onChange(draft, {
      ...draft,
      revision: draft.revision + 1,
      datasetRef: pinned,
      datasetInputsDirty: false,
      values: { ...draft.values, dataset: summary.name, datasetRevision: summary.revision },
    });
    if (!(await onAttach(pinned)))
      throw new Error("The Dataset is saved. Select Attach revision to retry attaching it.");
    showToast?.(`Dataset revision ${summary.revision} is attached.`, "success");
  }

  async function save() {
    if (!connection || !sessionId) throw new Error("Open the Dataset setup chat to save a draft.");
    const name = draft.values.name?.trim();
    if (!name || !examples.length || examples.some((row) => !row.prompt.trim()))
      throw new Error("Name the Dataset and enter a prompt for each example before saving.");
    const split = draft.values.split ?? "train";
    const objective = draft.values.objective?.trim() || name;
    const payload = {
      name,
      draft: {
        name,
        objective,
        tasks: examples.map(({ id, prompt, expected }) => ({
          schemaVersion: "openpond.taskData.v1",
          id,
          clusterKey: id,
          split,
          input: { prompt },
          expectedOutput: expected.trim() ? { text: expected } : null,
          policyVisibleContext: {},
          privilegedContextRef: null,
          sourceRefs: [],
          tags: [],
          metadata: {},
        })),
      },
    };
    const bytes = new TextEncoder().encode(
      JSON.stringify([sessionId, reference?.id, reference?.revision, payload]),
    );
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const operationId = `setup-dataset-${Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("")}`;
    const { summary } = await chatResourceRequest<DatasetResponse>(connection, "dataset", {
      ...(reference
        ? { action: "save", id: reference.id, expectedRevision: reference.revision }
        : { action: "create" }),
      payload,
      operationId,
    });
    await attach(summary);
  }

  async function publish() {
    if (!connection || !reference || !managedAvailable) return;
    const result = await chatResourceRequest<DatasetResponse>(connection, "dataset", {
      action: "publish",
      id: reference.id,
      expectedRevision: reference.revision,
    });
    const link = result.record.sync;
    if (
      !link ||
      link.status !== "synced" ||
      link.publicationIntent ||
      link.acknowledgedHash !== result.record.workspace.contentHash
    )
      throw new Error(link?.error ?? "The exact Dataset revision could not be published.");
    showToast?.("Dataset published to the linked workspace.", "success");
  }

  if (activeField === "fields" && fileSource) {
    const keys = [...new Set(sourceRows.flatMap((row) => Object.keys(row)))];
    const fieldOptions = keys.map((key) => ({ value: key, label: key }));
    return (
      <section className="resource-setup-fields">
        <label className="resource-setup-input">
          Source file
          <input
            type="file"
            accept=".json,.jsonl,application/json"
            disabled={busy}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (!file) return;
              void perform(async () => {
                const rows = await readSource(file);
                setSourceRows(rows);
                setSourceName(file.name);
                setPromptField("");
                setExpectedField("");
              });
            }}
          />
        </label>
        <p>
          Choose a JSON or JSON Lines file with up to 50 examples. Map its fields before saving.
        </p>
        {sourceRows.length > 0 && (
          <>
            <p>{sourceName}</p>
            <DropdownSelect
              label="Input field"
              value={promptField}
              disabled={busy}
              searchable
              options={[{ value: "", label: "Choose input field" }, ...fieldOptions]}
              onChange={setPromptField}
            />
            <DropdownSelect
              label="Expected output field"
              value={expectedField}
              disabled={busy}
              searchable
              options={[{ value: "", label: "No expected output field" }, ...fieldOptions]}
              onChange={setExpectedField}
            />
            <div>
              <button
                className="training-button secondary"
                type="button"
                disabled={busy || !promptField}
                onClick={() =>
                  void perform(async () => {
                    updateExamples(
                      mapSource(sourceRows, promptField, expectedField),
                      expectedField ? `${promptField} → ${expectedField}` : promptField,
                    );
                  })
                }
              >
                Use mapped rows
              </button>
            </div>
          </>
        )}
      </section>
    );
  }

  if (activeField !== "preview") return null;
  const rows = existing
    ? (preview.data?.record.workspace.draft.tasks.map((task) => ({
        id: task.id,
        prompt:
          typeof task.input.prompt === "string" ? task.input.prompt : JSON.stringify(task.input),
        expected: task.expectedOutput ? JSON.stringify(task.expectedOutput) : "",
      })) ?? [])
    : examples;
  const pageSize = draft.values.samples ?? 10;
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  return (
    <section className="resource-setup-fields" aria-label="Dataset rows">
      {source === "Write examples" && (
        <button
          className="training-button secondary"
          type="button"
          disabled={busy || rows.length >= MAX_EXAMPLES}
          onClick={() => {
            updateExamples(
              [...examples, { id: crypto.randomUUID(), prompt: "", expected: "" }],
              "Prompt and expected output",
            );
            setPage(Math.floor(examples.length / pageSize));
          }}
        >
          Add example
        </button>
      )}
      {rows.length > 0 && (
        <div className="training-table-wrap">
          <table className="training-data-table" aria-label="Dataset row preview">
            <thead>
              <tr>
                <th>Prompt</th>
                <th>Expected output</th>
                {source === "Write examples" && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {rows
                .slice(currentPage * pageSize, (currentPage + 1) * pageSize)
                .map((row, index) => {
                  const offset = currentPage * pageSize + index;
                  const label = `Row ${offset + 1}`;
                  const edit = (key: "prompt" | "expected", value: string) =>
                    onChange(draft, {
                      ...draft,
                      revision: draft.revision + 1,
                      datasetInputsDirty: true,
                      datasetExamples: examples.map((item, position) =>
                        position === offset ? { ...item, [key]: value } : item,
                      ),
                    });
                  return (
                    <tr key={row.id}>
                      {source === "Write examples" ? (
                        <>
                          <td>
                            <textarea
                              aria-label={`${label} prompt`}
                              value={row.prompt}
                              maxLength={MAX_EXAMPLE_TEXT}
                              disabled={busy}
                              onChange={(event) => edit("prompt", event.target.value)}
                            />
                          </td>
                          <td>
                            <textarea
                              aria-label={`${label} expected output`}
                              value={row.expected}
                              maxLength={MAX_EXAMPLE_TEXT}
                              disabled={busy}
                              onChange={(event) => edit("expected", event.target.value)}
                            />
                          </td>
                          <td>
                            <button
                              className="training-text-button"
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                updateExamples(
                                  examples.filter((_, position) => position !== offset),
                                )
                              }
                            >
                              Remove
                            </button>
                          </td>
                        </>
                      ) : (
                        <>
                          <td>{row.prompt}</td>
                          <td>{row.expected}</td>
                        </>
                      )}
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      )}
      {pageCount > 1 && (
        <div className="chat-resource-pagination">
          <button
            type="button"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            Previous
          </button>
          <span>
            {currentPage + 1}/{pageCount}
          </span>
          <button
            type="button"
            disabled={currentPage + 1 >= pageCount}
            onClick={() => setPage(currentPage + 1)}
          >
            Next
          </button>
        </div>
      )}
      {preview.isFetching && <p role="status">Reading the selected Dataset revision…</p>}
      {!source && <p>Choose a Dataset source to preview its rows.</p>}
      {fileSource && !rows.length && <p>Map a source file to preview its rows.</p>}
      {existing && preview.data && (
        <button
          className="training-button"
          type="button"
          disabled={busy}
          onClick={() => void perform(() => attach(preview.data.summary))}
        >
          Use this revision
        </button>
      )}
      {!existing && rows.length > 0 && (
        <div className="training-dialog-actions">
          {reference && !draft.datasetInputsDirty ? (
            <button
              className="training-button secondary"
              type="button"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  if (!(await onAttach(reference)))
                    throw new Error("Could not attach the saved Dataset revision.");
                  showToast?.(`Dataset revision ${reference.revision} is attached.`, "success");
                })
              }
            >
              Attach revision {reference.revision}
            </button>
          ) : (
            <button
              className="training-button"
              type="button"
              disabled={
                busy ||
                !connection ||
                !draft.values.name?.trim() ||
                rows.some((row) => !row.prompt.trim())
              }
              onClick={() => void perform(save)}
            >
              {reference ? "Save revision" : "Save draft"}
            </button>
          )}
          {reference &&
            !draft.datasetInputsDirty &&
            draft.values.destination === "OpenPond Managed" && (
              <button
                className="training-button secondary"
                type="button"
                disabled={busy || !managedAvailable}
                onClick={() => void perform(publish)}
              >
                Publish to OpenPond
              </button>
            )}
        </div>
      )}
    </section>
  );
}
