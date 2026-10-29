import { z } from "zod";
import { contentHash } from "@openpond/harness";
import {
  TOOL_LEARNING_LIMITS,
  ToolEpisodeEventSchema,
  ToolLearningHashSchema,
  ToolLearningRefSchema,
  type ToolEpisodeEvent,
} from "@openpond/evals/tool-learning";

export const ToolLearningEpisodeAssemblySchema = z.object({
  state: z.enum(["incomplete", "ambiguous", "awaiting_owner_review"]),
  issues: z.array(z.enum([
    "missing_attempt", "missing_observation", "completion_not_observed",
    "conflicting_observations", "reference_mismatch", "lineage_mismatch",
    "mixed_scope", "conflicting_event",
  ])).max(8),
  groups: z.array(z.object({
    key: ToolLearningHashSchema,
    application: z.string().min(1).max(200),
    applicationVersion: z.string().min(1).max(200),
    tool: z.object({
      name: z.string().min(1).max(200),
      version: z.string().max(200).nullable(),
      server: z.string().max(200).nullable(),
    }).strict(),
    environmentFingerprints: z.array(ToolLearningHashSchema).max(TOOL_LEARNING_LIMITS.eventsPerEpisode),
    attempts: z.array(ToolLearningRefSchema).max(TOOL_LEARNING_LIMITS.eventsPerEpisode),
  }).strict()).max(TOOL_LEARNING_LIMITS.eventsPerEpisode),
}).strict();

type Issue = z.infer<typeof ToolLearningEpisodeAssemblySchema>["issues"][number];
type Attempt = Extract<ToolEpisodeEvent, { eventKind: "attempt" }>;
type Observation = Extract<ToolEpisodeEvent, { eventKind: "observation" }>;

/** Structural assembly of retained calls, never recovery verification or label
 * approval. Conflicting observations remain visible instead of selecting the
 * most recently received answer. Recovery/verifier claims retain their separate
 * owner authority and are not promoted by this read projection. */
export function assembleToolLearningEpisode(raw: readonly ToolEpisodeEvent[]) {
  const events = z.array(ToolEpisodeEventSchema).max(TOOL_LEARNING_LIMITS.eventsPerEpisode).parse(raw);
  const incomplete = new Set<Issue>(), ambiguous = new Set<Issue>();
  const byId = new Map<string, ToolEpisodeEvent>();
  const first = events[0];
  for (const event of events) {
    if (first && (event.installationId !== first.installationId || event.episodeId !== first.episodeId))
      ambiguous.add("mixed_scope");
    if (event.parentSessionId === event.sessionId) ambiguous.add("lineage_mismatch");
    const previous = byId.get(event.eventId);
    if (previous && previous.contentHash !== event.contentHash) ambiguous.add("conflicting_event");
    else byId.set(event.eventId, event);
  }
  const attempts = [...byId.values()].filter((event): event is Attempt => event.eventKind === "attempt");
  const observations = new Map<string, Observation[]>();
  const callOwners = new Map<string, string>();
  if (!attempts.length) incomplete.add("missing_attempt");
  for (const event of byId.values()) {
    if (event.eventKind !== "observation") continue;
    const attempt = byId.get(event.payload.attempt.id);
    if (!attempt) incomplete.add("missing_attempt");
    else if (attempt.eventKind !== "attempt" ||
      attempt.contentHash !== event.payload.attempt.contentHash ||
      attempt.payload.actionHash !== event.payload.actionHash) ambiguous.add("reference_mismatch");
    else if (attempt.sessionId !== event.sessionId || attempt.callId !== event.callId ||
      (attempt.parentSessionId && event.parentSessionId && attempt.parentSessionId !== event.parentSessionId) ||
      (attempt.turnId && event.turnId && attempt.turnId !== event.turnId)) ambiguous.add("lineage_mismatch");
    const values = observations.get(event.payload.attempt.id) ?? [];
    values.push(event);
    observations.set(event.payload.attempt.id, values);
  }
  const grouped = new Map<string, {
    application: string; applicationVersion: string; tool: Attempt["payload"]["tool"];
    fingerprints: Set<string>; attempts: Array<{ id: string; contentHash: string }>;
  }>();
  for (const attempt of attempts) {
    const callKey = JSON.stringify([attempt.sessionId, attempt.callId]);
    const previousCall = callOwners.get(callKey);
    if (previousCall && previousCall !== attempt.contentHash) ambiguous.add("lineage_mismatch");
    callOwners.set(callKey, attempt.contentHash);
    const values = observations.get(attempt.eventId) ?? [];
    if (!values.length) incomplete.add("missing_observation");
    else {
      const terminal = values.filter((event) => event.payload.outcome !== "incomplete");
      if (!terminal.length) incomplete.add("completion_not_observed");
      if (new Set(terminal.map((event) => contentHash(event.payload))).size > 1)
        ambiguous.add("conflicting_observations");
    }
    const { environment, tool } = attempt.payload;
    const key = contentHash([environment.application, environment.version, tool.name, tool.version, tool.server]);
    const group = grouped.get(key) ?? {
      application: environment.application, applicationVersion: environment.version,
      tool, fingerprints: new Set<string>(), attempts: [],
    };
    group.fingerprints.add(environment.fingerprint);
    group.attempts.push({ id: attempt.eventId, contentHash: attempt.contentHash });
    grouped.set(key, group);
  }
  return ToolLearningEpisodeAssemblySchema.parse({
    state: ambiguous.size ? "ambiguous" : incomplete.size ? "incomplete" : "awaiting_owner_review",
    issues: [...new Set([...ambiguous, ...incomplete])].sort(),
    groups: [...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([key, group]) => ({
      key, application: group.application, applicationVersion: group.applicationVersion, tool: group.tool,
      environmentFingerprints: [...group.fingerprints].sort(),
      attempts: group.attempts.sort((a, b) => a.id.localeCompare(b.id)),
    })),
  });
}
