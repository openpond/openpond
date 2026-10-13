import { chatTrainingAttachmentKey, chatTrainingReference, type ChatTrainingAttachment, TaskResourceContextsSchema, type ChatResourceSummary, type TaskResourceContext } from "@openpond/contracts";
import type { useChatResourceFocus } from "../../hooks/useChatResourceFocus";

export function captureComposerResourceContext(resources: ReturnType<typeof useChatResourceFocus>, training?: ChatTrainingAttachment): TaskResourceContext[] {
  if (!resources.scope || !resources.focus.scopeContext) return [];
  const previous = resources.scope.runs.at(-1);
  const run = resources.focus.experiment ?? (previous ? resources.experiments.find(item=>item.id===previous.id) ?? previous : null);
  const references = [resources.focus.dataset, run, ...resources.graders]
    .filter((value): value is ChatResourceSummary => Boolean(value))
    .map(({kind, id, revision, datasetId, datasetRevision, owner, profileRef}) => ({
      kind, id, revision, datasetId, datasetRevision, owner, profileRef,
    }));
  const job = training ?? resources.scope.training?.find(candidate => chatTrainingAttachmentKey(candidate) === resources.scope!.selectedTrainingKey);
  return TaskResourceContextsSchema.parse([{
    scopeId: resources.scope.id,
    selectionVersion: resources.focus.scopeContext.selectionVersion,
    ...(resources.scope.evaluationModel ? {evaluationModel:resources.scope.evaluationModel} : {}),
    executionLocation: resources.scope.executionLocation ?? "local",
    resources: references,
    ...(job ? {training:[chatTrainingReference(job)]} : {}),
  }]);
}

export function mergeComposerResourceContexts(current: TaskResourceContext[], added: TaskResourceContext[]): TaskResourceContext[] {
  const unique = new Map([...current, ...added].map(context => [JSON.stringify(context), context]));
  return TaskResourceContextsSchema.parse([...unique.values()]);
}

export function composerResourceMetadata(contexts: TaskResourceContext[]): Record<string, unknown> {
  if (!contexts.length) return {};
  return {
    chatResourceContexts: contexts,
    ...(contexts.length === 1 ? {
      chatExperimentScopeId: contexts[0]!.scopeId,
      chatExperimentSelectionVersion: contexts[0]!.selectionVersion,
    } : {}),
  };
}
