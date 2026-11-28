import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { LocalDatasetCheck } from "@openpond/contracts";
import type { ClientConnection } from "../../api/api-client";
import {
  chatResourceRequest,
  type DatasetResponse,
  publishLocalDatasetRevision,
} from "../../api/chat-resource-api";
import { useAppToast, useErrorToast } from "../../app/AppToastContext";
import { connectionQueryScope } from "../../lib/query-scope";
import type { ResourceSetupDraft } from "../../lib/resource-setup-prompt";
import { DropdownSelect } from "../DropdownSelect";

type DatasetRef = NonNullable<ResourceSetupDraft["datasetRef"]>;
type Examples = NonNullable<ResourceSetupDraft["graderExamples"]>;
type CheckResult = {
  check: LocalDatasetCheck;
  grader: NonNullable<LocalDatasetCheck["scopes"]>[number] | null;
};

export function GraderSetupReview({
  draft,
  connection,
  busy,
  active,
  managedAvailable,
  onChange,
  onAttach,
  onBusy,
}: {
  draft: ResourceSetupDraft;
  connection: ClientConnection | null;
  busy: boolean;
  active: boolean;
  managedAvailable: boolean;
  onChange(current: ResourceSetupDraft, next: ResourceSetupDraft): void;
  onAttach(reference: DatasetRef): Promise<boolean>;
  onBusy(busy: boolean): void;
}) {
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<{ input: string; review: CheckResult } | null>(null);
  const showToast = useAppToast();
  const reference = draft.datasetRef;
  const examples = draft.graderExamples;
  const saved = Boolean(reference && examples?.savedSetupRevision === draft.revision);
  const dataset = useQuery({
    queryKey: [
      "resource-setup-grader-dataset",
      connectionQueryScope(connection),
      reference?.id,
      reference?.revision,
      reference?.contentHash,
    ],
    enabled: Boolean(active && connection && reference),
    queryFn: async ({ signal }) => {
      const response = await chatResourceRequest<DatasetResponse>(
        connection!,
        "dataset",
        {
          action: "read",
          id: reference!.id,
          expectedRevision: reference!.revision,
        },
        signal,
      );
      if (
        reference!.contentHash &&
        response.record.workspace.contentHash !== reference!.contentHash
      )
        throw new Error("The selected Dataset no longer matches its pinned revision.");
      return response;
    },
    staleTime: Infinity,
  });
  useErrorToast(error ?? dataset.error);
  const tasks = useMemo(
    () =>
      (dataset.data?.record.workspace.draft.tasks ?? []).flatMap((task) => {
        const answer = task.expectedOutput?.text;
        return typeof answer === "string" && answer.trim()
          ? [
              {
                id: task.id,
                answer,
                label: typeof task.input.prompt === "string" ? task.input.prompt : task.id,
              },
            ]
          : [];
      }),
    [dataset.data],
  );
  const task = tasks.find((candidate) => candidate.id === examples?.taskId);
  const name = draft.values.name?.trim();
  const payload =
    task && examples?.positive?.trim() && examples.negative?.trim() && name
      ? {
          fixtureScope: "grader",
          grader: {
            id: examples.id,
            version: "1",
            label: name,
            kind: "content",
            weight: 1,
            hardGate: true,
            rewardEligible: false,
            privileged: true,
            config: { operator: "final_answer_equals_expected" },
            metadata: draft.values.criterion ? { criterion: draft.values.criterion } : {},
          },
          fixtures: [
            { label: "positive", text: examples.positive, passed: true },
            { label: "negative", text: examples.negative, passed: false },
          ].map(({ label, text, passed }) => ({
            id: `${examples.id}-${label}`,
            taskId: task.id,
            label,
            output: { text },
            infrastructureError: null,
            expectedPassed: passed,
            expectedRewardEligible: false,
            metadata: {},
          })),
        }
      : null;
  const input = JSON.stringify([reference, payload]);
  const review = result?.input === input ? result.review : null;
  if (!active) return null;

  function change(patch: Partial<Examples>) {
    onChange(draft, {
      ...draft,
      revision: draft.revision + 1,
      graderExamples: {
        id: examples?.id ?? crypto.randomUUID(),
        ...examples,
        ...patch,
      },
    });
  }

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

  async function check() {
    if (!connection || !reference || !payload) return;
    const review = await chatResourceRequest<CheckResult>(connection, "dataset", {
      action: "preview_grader",
      id: reference.id,
      expectedRevision: reference.revision,
      payload,
    });
    setResult({ input, review });
  }

  async function save() {
    if (!connection || !reference || !payload || review?.grader?.status !== "passed") return;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    const operationId = `setup-grader-${Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("")}`;
    const { summary } = await chatResourceRequest<DatasetResponse>(connection, "dataset", {
      action: "save_grader",
      id: reference.id,
      expectedRevision: reference.revision,
      operationId,
      payload,
    });
    const pinned = {
      id: summary.id,
      revision: summary.revision,
      contentHash: summary.evaluationHash,
    };
    onChange(draft, {
      ...draft,
      revision: draft.revision + 1,
      datasetRef: pinned,
      graderExamples: examples && { ...examples, savedSetupRevision: draft.revision + 1 },
      values: { ...draft.values, datasetRevision: summary.revision },
    });
    if (!(await onAttach(pinned)))
      throw new Error("The Grader is saved. Select its Dataset revision to attach it.");
    showToast?.(`Grader saved in Dataset revision ${summary.revision}.`, "success");
  }

  async function publish() {
    if (!connection || !reference || !managedAvailable || !saved) return;
    await publishLocalDatasetRevision(connection, reference);
    showToast?.("Dataset revision published with its Grader.", "success");
  }

  return (
    <section className="resource-setup-fields" aria-label="Grader fixtures">
      {!reference && <p>Choose a Dataset revision for the Grader.</p>}
      {dataset.isFetching && <p role="status">Reading the selected Dataset revision…</p>}
      {dataset.data && !tasks.length && (
        <p>Add a task with an expected text answer to check this Grader.</p>
      )}
      {tasks.length > 0 && (
        <>
          <DropdownSelect
            label="Fixture task"
            disabled={busy}
            value={task?.id ?? ""}
            searchable
            options={[
              { value: "", label: "Choose a task" },
              ...tasks.map((row) => ({ value: row.id, label: row.label })),
            ]}
            onChange={(taskId) =>
              change({
                taskId: taskId || undefined,
                positive: tasks.find((task) => task.id === taskId)?.answer.slice(0, 2_000),
                negative: undefined,
              })
            }
          />
          {task && (
            <>
              <label className="resource-setup-input">
                Passing output
                <textarea
                  value={examples?.positive ?? ""}
                  maxLength={2_000}
                  disabled={busy}
                  onChange={(event) => change({ positive: event.target.value })}
                />
              </label>
              <label className="resource-setup-input">
                Failing output
                <textarea
                  value={examples?.negative ?? ""}
                  maxLength={2_000}
                  disabled={busy}
                  onChange={(event) => change({ negative: event.target.value })}
                />
              </label>
            </>
          )}
        </>
      )}
      {review?.grader && (
        <div role="status">
          <p>
            {review.grader.checked} of {review.grader.total} fixtures checked,{" "}
            {review.grader.status}.
          </p>
          {review.check.issues
            .filter((issue) => issue.graderId === review.grader?.graderId)
            .map((issue, index) => (
              <p key={index}>{issue.message}</p>
            ))}
        </div>
      )}
      {task && (
        <div className="training-dialog-actions">
          <button
            className="training-button secondary"
            type="button"
            disabled={busy || !payload}
            onClick={() => void perform(check)}
          >
            Check fixtures
          </button>
          <button
            className="training-button"
            type="button"
            disabled={busy || saved || review?.grader?.status !== "passed"}
            onClick={() => void perform(save)}
          >
            Save grader
          </button>
          {saved && managedAvailable && (
            <button
              className="training-button secondary"
              type="button"
              disabled={busy}
              onClick={() => void perform(publish)}
            >
              Publish Dataset revision
            </button>
          )}
        </div>
      )}
    </section>
  );
}
