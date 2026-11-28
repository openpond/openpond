import { ChatExperimentContextSchema, type Session } from "@openpond/contracts";
import { SessionResourceDraftSchema } from "@openpond/contracts/requests";

import { ownsHostedBenchmarkVersion } from "@openpond/contracts/resource-setup";
import type { hostedModelScope } from "./hosted-model-scope";

export function sessionBenchmarkDraft(session: Session, workspace: ReturnType<typeof hostedModelScope>) {
  if (session.archived || !session.metadata?.resourceDraft) return null;
  const resource = SessionResourceDraftSchema.safeParse(session.metadata.resourceDraft);
  if (!resource.success || resource.data.kind !== "benchmark") return null;
  const version = resource.data.benchmarkVersion;
  if (version?.location === "cloud" && !ownsHostedBenchmarkVersion(version, workspace)) return null;
  const context = ChatExperimentContextSchema.safeParse(session.metadata?.chatExperimentContext);
  if (!context.success) return null;
  return context.data.scopes.find(scope => scope.draft?.id === resource.data.id) ?? null;
}
