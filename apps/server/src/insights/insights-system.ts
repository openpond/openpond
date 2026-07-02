import path from "node:path";
import {
  InsightRunSchema,
  type AppPreferences,
  type ChatModelRef,
  type ChatProvider,
  type ContextUsageSnapshot,
  type InsightEvidenceSource,
  type InsightRun,
  type InsightRunStatus,
  type InsightRunTrigger,
  type LocalProject,
  type Session,
  type Turn,
} from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";
import { now } from "../utils.js";
import { ensureSystemLocalProject } from "../workspace/local-projects.js";

export const INSIGHTS_SYSTEM_KIND = "openpond.insights" as const;
export const INSIGHTS_SYSTEM_PROJECT_ID = "system_openpond_insights" as const;
export const INSIGHTS_SYSTEM_SESSION_TITLE = "Insights" as const;

export type InsightsSystemDeps = {
  store: SqliteStore;
  storeDir: string;
  createSession: (payload: unknown) => Promise<Session>;
  updateSession: (sessionId: string, patch: Partial<Session>) => Promise<Session>;
  loadAppPreferences: () => Promise<AppPreferences>;
};

export type InsightsRunMetadata = {
  id: string;
  trigger: InsightRunTrigger;
  status: InsightRunStatus;
  startedAt: string;
  completedAt: string | null;
  elapsedMs: number | null;
  usage: ContextUsageSnapshot | null;
  evidenceSources: InsightEvidenceSource[];
  evidenceHash: string | null;
  sourceEventSequence: number | null;
  findingCount: number;
  createdCount: number;
  updatedCount: number;
  resolvedCount: number;
  summary: string | null;
  error: string | null;
};

export function insightsSystemProjectPath(storeDir: string): string {
  return path.join(storeDir, "system-projects", "insights");
}

export async function ensureInsightsSystemProject(input: {
  store: SqliteStore;
  storeDir: string;
}): Promise<LocalProject> {
  return ensureSystemLocalProject(input.store, {
    id: INSIGHTS_SYSTEM_PROJECT_ID,
    name: INSIGHTS_SYSTEM_SESSION_TITLE,
    workspacePath: insightsSystemProjectPath(input.storeDir),
    systemKind: INSIGHTS_SYSTEM_KIND,
    hiddenFromDefaultSidebar: true,
  });
}

export async function createInsightsSystemSession(
  deps: InsightsSystemDeps,
  input: { title?: string } = {},
): Promise<Session> {
  const project = await ensureInsightsSystemProject({ store: deps.store, storeDir: deps.storeDir });
  const preferences = await deps.loadAppPreferences();
  const modelRef = defaultInsightsModelRef(preferences);
  return deps.createSession({
    provider: modelRef.providerId as ChatProvider,
    modelRef,
    title: input.title ?? INSIGHTS_SYSTEM_SESSION_TITLE,
    workspaceKind: "local_project",
    workspaceId: project.id,
    workspaceName: project.name,
    localProjectId: project.id,
    cwd: project.workspacePath,
    systemKind: INSIGHTS_SYSTEM_KIND,
    hiddenFromDefaultSidebar: true,
  });
}

export async function listInsightsSystemSessions(store: SqliteStore): Promise<Session[]> {
  return (await store.sessionShells())
    .filter((session) => session.systemKind === INSIGHTS_SYSTEM_KIND)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

export function defaultInsightsModelRef(preferences: AppPreferences): ChatModelRef {
  return preferences.insightsModelRef ?? preferences.defaultChatModelRef ?? {
    providerId: preferences.defaultChatProvider,
    modelId: preferences.defaultChatModel,
  };
}

export async function listInsightsRuns(store: SqliteStore, sessionId: string, limit = 20): Promise<InsightRun[]> {
  const turns = await store.turnsForSession(sessionId, limit);
  return turns.map(insightsRunFromTurn).filter((run): run is InsightRun => Boolean(run));
}

export async function listInsightsRunsForSessions(
  store: SqliteStore,
  sessions: Session[],
  limit = 20,
): Promise<InsightRun[]> {
  const turnsBySession = await Promise.all(sessions.map((session) => store.turnsForSession(session.id, limit)));
  return turnsBySession
    .flat()
    .map(insightsRunFromTurn)
    .filter((run): run is InsightRun => Boolean(run))
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
    .slice(0, limit);
}

export function insightsRunFromTurn(turn: Turn): InsightRun | null {
  const metadata = runMetadata(turn);
  if (!metadata) return null;
  const parsed = InsightRunSchema.safeParse({
    id: metadata.id,
    sessionId: turn.sessionId,
    turnId: turn.id,
    trigger: metadata.trigger,
    status: metadata.status ?? statusFromTurn(turn),
    startedAt: metadata.startedAt ?? turn.startedAt,
    completedAt: metadata.completedAt ?? turn.completedAt,
    elapsedMs: metadata.elapsedMs ?? elapsedMsBetween(metadata.startedAt ?? turn.startedAt, metadata.completedAt ?? turn.completedAt),
    modelRef: turn.modelRef ?? null,
    usage: metadata.usage ?? null,
    evidenceSources: metadata.evidenceSources ?? [],
    evidenceHash: metadata.evidenceHash ?? null,
    sourceEventSequence: metadata.sourceEventSequence ?? null,
    findingCount: metadata.findingCount ?? 0,
    createdCount: metadata.createdCount ?? 0,
    updatedCount: metadata.updatedCount ?? 0,
    resolvedCount: metadata.resolvedCount ?? 0,
    summary: metadata.summary ?? null,
    error: metadata.error ?? turn.error ?? null,
  });
  return parsed.success ? parsed.data : null;
}

export function initialInsightsRunMetadata(input: {
  id: string;
  trigger: InsightRunTrigger;
  evidenceHash: string | null;
  sourceEventSequence: number | null;
  evidenceSources?: InsightEvidenceSource[];
}): InsightsRunMetadata {
  return {
    id: input.id,
    trigger: input.trigger,
    status: "running",
    startedAt: now(),
    completedAt: null,
    elapsedMs: null,
    usage: null,
    evidenceSources: input.evidenceSources ?? [],
    evidenceHash: input.evidenceHash,
    sourceEventSequence: input.sourceEventSequence,
    findingCount: 0,
    createdCount: 0,
    updatedCount: 0,
    resolvedCount: 0,
    summary: null,
    error: null,
  };
}

export function withInsightsRunMetadata(turn: Turn, metadata: InsightsRunMetadata): Turn {
  return {
    ...turn,
    metadata: {
      ...(turn.metadata ?? {}),
      insightsRun: metadata,
    },
  };
}

function runMetadata(turn: Turn): Partial<InsightsRunMetadata> | null {
  const value = turn.metadata?.insightsRun;
  if (!value || typeof value !== "object") return null;
  return value as Partial<InsightsRunMetadata>;
}

function statusFromTurn(turn: Turn): InsightRunStatus {
  if (turn.status === "in_progress") return "running";
  if (turn.status === "completed") return "completed";
  return "failed";
}

function elapsedMsBetween(startedAt: string | null | undefined, completedAt: string | null | undefined): number | null {
  if (!startedAt || !completedAt) return null;
  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) return null;
  return completed - started;
}
