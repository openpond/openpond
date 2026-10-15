import {
  ChatResourceSummarySchema,
  chatTrainingReference,
  TaskResourceContextsSchema,
  type ChatResourceSummary,
  type ChatTrainingAttachment,
  type TaskResourceContext,
} from "@openpond/contracts";
import type { useChatResourceFocus } from "../../hooks/useChatResourceFocus";

export const resourceIdentity = (resource: ChatResourceSummary) =>
  JSON.stringify([resource.kind, resource.id, resource.owner ?? null, resource.profileRef ?? null]);
export const sameDataset = (run: ChatResourceSummary, dataset: ChatResourceSummary) =>
  run.datasetId === dataset.id &&
  JSON.stringify(run.owner ?? null) === JSON.stringify(dataset.owner ?? null) &&
  JSON.stringify(run.profileRef ?? null) === JSON.stringify(dataset.profileRef ?? null);
export const activeRun = (state: string) =>
  /^(queued|running|pending|starting|cancelling)$/i.test(state);
export function workspaceRunName(run: ChatResourceSummary) {
  const suffix = run.model ? ` · ${run.model.split("/").at(-1)}` : "";
  return suffix && run.name.endsWith(suffix) ? run.name.slice(0, -suffix.length) : run.name;
}
export function workspaceRunModel(run: ChatResourceSummary) {
  return run.model?.includes("/")
    ? run.model.slice(run.model.indexOf("/") + 1)
    : (run.model ?? "Unavailable");
}
export function workspaceSummaries(value: unknown): ChatResourceSummary[] {
  return ChatResourceSummarySchema.array().parse(value);
}

/** A history-row action must carry that run's immutable input pin, not today's picker revision. */
export function datasetWorkspaceContext(
  resources: ReturnType<typeof useChatResourceFocus>,
  run?: ChatResourceSummary,
  training?: ChatTrainingAttachment,
): TaskResourceContext[] {
  const { scope, focus } = resources;
  if (!scope || !focus.scopeContext || !focus.dataset) return [];
  const dataset = focus.dataset;
  if (run && !sameDataset(run, dataset))
    throw new Error("This run belongs to a different Dataset.");
  const revision = run?.datasetRevision ?? dataset.revision;
  const pins = [
    {
      kind: "dataset" as const,
      id: dataset.id,
      revision,
      owner: dataset.owner,
      profileRef: dataset.profileRef,
    },
    ...(run
      ? [
          {
            kind: run.kind,
            id: run.id,
            revision: run.revision,
            datasetId: run.datasetId,
            datasetRevision: revision,
            owner: run.owner,
            profileRef: run.profileRef,
          },
        ]
      : []),
    ...(!run || revision === dataset.revision
      ? resources.graders.map((grader) => ({
          kind: grader.kind,
          id: grader.id,
          revision: grader.revision,
          datasetId: grader.datasetId,
          datasetRevision: grader.datasetRevision,
          owner: grader.owner,
          profileRef: grader.profileRef,
        }))
      : []),
  ];
  return TaskResourceContextsSchema.parse([
    {
      scopeId: scope.id,
      selectionVersion: focus.scopeContext.selectionVersion,
      evaluationModel: run?.model ?? scope.evaluationModel,
      executionLocation: run?.location ?? scope.executionLocation ?? "local",
      resources: pins,
      ...(training ? { training: [chatTrainingReference(training)] } : {}),
    },
  ]);
}
