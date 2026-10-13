import { TaskResourceContextsSchema, type ChatResourceSummary, type TaskResourceContext } from "@openpond/contracts";
import type { useChatResourceFocus } from "../../hooks/useChatResourceFocus";

export function captureComposerResourceContext(resources: ReturnType<typeof useChatResourceFocus>): TaskResourceContext[] {
  if (!resources.scope || !resources.focus.scopeContext) return [];
  const selected = resources.scope.selectedGraderId
    ? resources.graders.filter(grader => grader.id === resources.scope!.selectedGraderId)
    : resources.graders;
  const references = [resources.focus.dataset, resources.focus.experiment, ...selected]
    .filter((value): value is ChatResourceSummary => Boolean(value))
    .map(({kind, id, revision, datasetId, datasetRevision, owner, profileRef}) => ({
      kind, id, revision, datasetId, datasetRevision, owner, profileRef,
    }));
  return TaskResourceContextsSchema.parse([{
    scopeId: resources.scope.id,
    selectionVersion: resources.focus.scopeContext.selectionVersion,
    resources: references,
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
