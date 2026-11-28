import { ChatExperimentContextSchema, type Session } from "@openpond/contracts";
import { SessionResourceDraftSchema } from "@openpond/contracts/requests";

import { ownsHostedBenchmarkVersion } from "@openpond/contracts/resource-setup";
import type { hostedModelScope } from "./hosted-model-scope";

export function sessionBenchmarkDraft(session: Session, workspace: ReturnType<typeof hostedModelScope>) {
  if (session.archived || !session.metadata?.resourceDraft) return null;
  const resource = SessionResourceDraftSchema.safeParse(session.metadata.resourceDraft);
  if (!resource.success || resource.data.kind !== "benchmark") return null;
  const context = ChatExperimentContextSchema.safeParse(session.metadata?.chatExperimentContext);
  const scope = context.data?.scopes.find(item => item.draft?.id === resource.data.id);
  const version = scope?.managedBenchmarkVersions?.candidate ?? resource.data.benchmarkVersion;
  if (version?.location === "cloud" && !ownsHostedBenchmarkVersion(version, workspace)) return null;
  return scope ?? null;
}
