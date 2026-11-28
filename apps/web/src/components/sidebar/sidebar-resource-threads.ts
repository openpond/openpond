import { ChatContextTargetSchema, type Session, type TrainingNavigationResponse } from "@openpond/contracts";
import { SessionResourceDraftSchema } from "@openpond/contracts/requests";
import { sessionBenchmarkDraft } from "../../lib/session-benchmark";

export function sidebarResourceThreads(
  sessions: readonly Session[], visible: readonly Session[], models: TrainingNavigationResponse["projects"],
  workspace: { apiOrigin: string; teamId: string } | null,
) {
  const modelIds = new Set(models.map(model => model.id));
  const hostedIds = new Map(models.filter(model => workspace && model.hostedProjectId &&
    model.apiOrigin === workspace.apiOrigin && model.teamId === workspace.teamId)
    .map(model => [model.hostedProjectId!, model.id]));
  const drafts = new Map(sessions.flatMap(owner => {
    const scope = sessionBenchmarkDraft(owner);
    return scope ? [[owner.id, { owner, scope }] as const] : [];
  }));
  const modelsById = new Map<string, Session[]>();
  const benchmarks = new Map<string, { owner: Session; name: string; chats: Session[] }>();
  const grouped = new Set<string>();

  for (const session of visible) {
    const draft = session.metadata?.resourceDraft ? SessionResourceDraftSchema.safeParse(session.metadata.resourceDraft).data : undefined;
    const target = session.metadata?.chatContextSelection ? ChatContextTargetSchema.safeParse(session.metadata.chatContextSelection).data : undefined;
    let model: string | undefined;
    if (target?.kind === "model") {
      if (target.location === "local" && modelIds.has(target.id)) model = target.id;
      if (target.location === "cloud" && workspace && target.teamId === workspace.teamId && target.apiOrigin === workspace.apiOrigin)
        model = hostedIds.get(target.id);
    }
    const modelGroups = new Set([draft?.kind === "model" ? draft.id : null, model]);
    for (const modelId of modelGroups) {
      if (!modelId) continue;
      const chats = modelsById.get(modelId) ?? [];
      chats.push(session);
      modelsById.set(modelId, chats);
      grouped.add(session.id);
    }

    const attached = target?.kind === "experiment" && target.location === "local" && target.sessionId && target.id === target.scopeId
      ? drafts.get(target.sessionId) : undefined;
    const benchmarkOwners = new Map<string, { owner: Session; name: string }>();
    if (draft?.kind === "benchmark") benchmarkOwners.set(session.id, { owner: session, name: drafts.get(session.id)?.scope.name ?? session.title });
    if (attached && attached.scope.id === target?.scopeId)
      benchmarkOwners.set(attached.owner.id, { owner: attached.owner, name: attached.scope.name });
    for (const [ownerId, owner] of benchmarkOwners) {
      const group = benchmarks.get(ownerId) ?? { ...owner, chats: [] };
      group.chats.push(session);
      benchmarks.set(ownerId, group);
      grouped.add(session.id);
    }
  }
  return { modelsById, benchmarks, grouped };
}
