import { createHash, randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import {
  CONTINUOUS_LEARNING_DEFAULT_POLICY,
  CONTINUOUS_LEARNING_DEFAULT_POLICY_VERSION,
  CONTINUOUS_LEARNING_RECEIPT_CONTRACT_VERSION,
  CONTINUOUS_LEARNING_RECOMMENDATION_CONTRACT_VERSION,
  CONTINUOUS_LEARNING_RECOMMENDATION_PROMPT,
  CONTINUOUS_LEARNING_RECOMMENDATION_PROMPT_VERSION,
  CONTINUOUS_LEARNING_TEMPLATE_KEY,
  ContinuousLearningRecommendationOutputSchema,
  EnsureLocalContinuousLearningRequestSchema,
  GET_CONVERSATIONS_CONTRACT_VERSION,
  GetConversationsToolInputSchema,
  GetConversationsToolResultSchema,
  LocalContinuousLearningStateSchema,
  LocalConversationLearningConsentSchema,
  PatchLocalContinuousLearningRequestSchema,
  SetLocalConversationLearningConsentRequestSchema,
  type ContinuousLearningReceipt,
  type GetConversationsToolResult,
  type LocalContinuousLearningDefinition,
  type LocalContinuousLearningRun,
  type LocalContinuousLearningState,
  type Session,
} from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";
import type { TasksetAuthoringSkillArtifact } from "./task-authoring-skill.js";

const RESULT_START = "<openpond-continuous-learning-recommendation>";
const RESULT_END = "</openpond-continuous-learning-recommendation>";
const MAX_RUN_HISTORY = 50;

type Logger = {
  warn(message: string, metadata?: Record<string, unknown>): void;
};

export function createLocalContinuousLearningService(input: {
  store: SqliteStore;
  skillArtifact: TasksetAuthoringSkillArtifact;
  createSession(payload: unknown): Promise<Session>;
  sendTurn(sessionId: string, payload: unknown): Promise<{ status: string }>;
  interruptSessionTurn(sessionId: string): Promise<unknown>;
  isClosing(): boolean;
  logger?: Logger;
  tickMs?: number;
}) {
  const running = new Map<string, { sessionId: string | null }>();
  const evidenceByRun = new Map<string, GetConversationsToolResult>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let tickRunning = false;

  async function list(): Promise<LocalContinuousLearningState[]> {
    return Promise.all(
      (await input.store.listLocalContinuousLearningStates()).map((state) =>
        Promise.resolve(LocalContinuousLearningStateSchema.parse(state)),
      ),
    );
  }

  async function get(id: string): Promise<LocalContinuousLearningState | null> {
    const state = await input.store.getLocalContinuousLearningState(id);
    return state ? LocalContinuousLearningStateSchema.parse(state) : null;
  }

  async function ensure(
    value: unknown,
  ): Promise<LocalContinuousLearningState> {
    const request = EnsureLocalContinuousLearningRequestSchema.parse(value);
    const workspaceId = request.scope === "my_team"
      ? request.workspaceId ?? null
      : null;
    if (request.scope === "my_team" && !workspaceId) {
      throw new Error("My Team review requires a Team workspace ID.");
    }
    const id = stateId(request.profileId, request.scope, workspaceId);
    const existing = await get(id);
    const timestamp = new Date().toISOString();
    const definition = currentDefinition(existing);
    const requiredDefinition = definitionFor({
      existing,
      profileId: request.profileId,
      scope: request.scope,
      workspaceId,
      artifact: input.skillArtifact,
      model: request.model ?? definition?.model ?? null,
      createdAt: timestamp,
    });
    const definitions = definition && sameTemplate(definition, requiredDefinition)
      ? existing!.definitions
      : [...(existing?.definitions ?? []), requiredDefinition];
    const current = definitions.at(-1)!;
    const enabled = request.enabled ?? existing?.schedule.enabled ?? false;
    const localTime = request.localTime
      ?? existing?.schedule.localTime
      ?? CONTINUOUS_LEARNING_DEFAULT_POLICY.cadence.localTime;
    const timezone = request.timezone
      ?? existing?.schedule.timezone
      ?? Intl.DateTimeFormat().resolvedOptions().timeZone
      ?? "UTC";
    const scheduleId = existing?.schedule.id ?? `${id}:schedule`;
    const state = LocalContinuousLearningStateSchema.parse({
      schemaVersion: "openpond.localContinuousLearningState.v1",
      id,
      profileId: request.profileId,
      scope: request.scope,
      workspaceId,
      definitions,
      currentDefinitionId: current.id,
      schedule: {
        schemaVersion: "openpond.localSavedWorkSchedule.v1",
        id: scheduleId,
        definitionId: current.id,
        enabled,
        localTime,
        timezone,
        nextRunAt: enabled
          ? preserveOrCalculateNextRun(existing, localTime, timezone)
          : null,
        lastRunAt: existing?.schedule.lastRunAt ?? null,
        lastRunStatus: existing?.schedule.lastRunStatus ?? null,
        latestResultSessionId: existing?.schedule.latestResultSessionId ?? null,
        inputWatermark: existing?.schedule.inputWatermark ?? null,
        createdAt: existing?.schedule.createdAt ?? timestamp,
        updatedAt: timestamp,
      },
      runs: existing?.runs ?? [],
      onboardingDecision:
        request.onboardingDecision
        ?? existing?.onboardingDecision
        ?? "unseen",
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });
    return input.store.upsertLocalContinuousLearningState(state);
  }

  async function patch(
    id: string,
    value: unknown,
  ): Promise<LocalContinuousLearningState> {
    const request = PatchLocalContinuousLearningRequestSchema.parse(value);
    const existing = await requireState(id);
    return ensure({
      profileId: existing.profileId,
      scope: existing.scope,
      workspaceId: existing.workspaceId,
      enabled: request.enabled ?? existing.schedule.enabled,
      localTime: request.localTime ?? existing.schedule.localTime,
      timezone: request.timezone ?? existing.schedule.timezone,
      onboardingDecision:
        request.onboardingDecision ?? existing.onboardingDecision,
      model: request.model ?? currentDefinition(existing)?.model,
    });
  }

  async function setConversationConsent(
    sessionId: string,
    value: unknown,
  ): Promise<Session> {
    const request = SetLocalConversationLearningConsentRequestSchema.parse(value);
    const session = await input.store.getSession(sessionId);
    if (!session) throw new Error("Conversation not found.");
    const timestamp = new Date().toISOString();
    const workspaceId = request.scope === "my_team"
      ? request.workspaceId ?? session.cloudTeamId ?? null
      : null;
    if (request.scope === "my_team" && !workspaceId) {
      throw new Error("My Team consent requires a Team conversation.");
    }
    const consent = LocalConversationLearningConsentSchema.parse({
      schemaVersion: "openpond.localConversationLearningConsent.v1",
      status: request.status,
      scope: request.scope,
      workspaceId,
      grantedAt:
        consentFromSession(session)?.grantedAt ?? timestamp,
      revokedAt: request.status === "revoked" ? timestamp : null,
    });
    const updated = await input.store.updateSession(sessionId, (current) => ({
      ...current,
      metadata: {
        ...current.metadata,
        continuousLearningConsent: consent,
      },
      updatedAt: timestamp,
    }));
    if (!updated) throw new Error("Conversation not found.");
    return updated;
  }

  async function getConversations(
    session: Session,
    args: unknown,
  ): Promise<GetConversationsToolResult> {
    GetConversationsToolInputSchema.parse(args);
    const binding = runtimeBinding(session);
    const state = await requireState(binding.stateId);
    const definition = definitionById(state, binding.definitionId);
    if (binding.runId !== state.runs[0]?.id && !running.has(binding.runId)) {
      throw new Error("Continuous-learning run binding is no longer active.");
    }
    const result = await collectConversations({
      store: input.store,
      state,
      definition,
      excludedSessionId: session.id,
    });
    evidenceByRun.set(binding.runId, result);
    return result;
  }

  async function runNow(
    stateIdValue: string,
    trigger: "manual" | "schedule" = "manual",
  ): Promise<LocalContinuousLearningRun> {
    const state = await requireState(stateIdValue);
    if (running.has(state.id)) throw new Error("This review is already running.");
    const definition = currentDefinition(state)!;
    const timestamp = new Date().toISOString();
    const run: LocalContinuousLearningRun = {
      schemaVersion: "openpond.localSavedWorkRun.v1",
      id: `local_cl_run_${randomUUID()}`,
      scheduleId: state.schedule.id,
      definitionId: definition.id,
      trigger,
      status: "running",
      scheduledFor: state.schedule.nextRunAt ?? timestamp,
      sessionId: null,
      receipt: null,
      error: null,
      startedAt: timestamp,
      completedAt: null,
    };
    const claimed = await saveRun(state, run, {
      ...(trigger === "schedule"
        ? { nextRunAt: nextDailyRunAt(state.schedule.localTime, state.schedule.timezone) }
        : {}),
    });
    running.set(state.id, { sessionId: null });
    try {
      const session = await input.createSession({
        experience: "work",
        provider: definition.model.provider,
        modelRef: {
          providerId: definition.model.provider,
          modelId: definition.model.model,
        },
        currentProfile: null,
        title: "Continuous learning review",
        metadata: {
          continuousLearning: {
            stateId: claimed.id,
            definitionId: definition.id,
            runId: run.id,
          },
        },
      });
      running.set(state.id, { sessionId: session.id });
      await saveRun(await requireState(state.id), { ...run, sessionId: session.id });
      let durationTimer: ReturnType<typeof setTimeout> | null = null;
      const turn = await Promise.race([
        input.sendTurn(session.id, {
          prompt: `$openpond-taskset-authoring\n\n${definition.prompt}`,
          modelRef: {
            providerId: definition.model.provider,
            modelId: definition.model.model,
          },
          codexReasoningEffort: definition.model.reasoningEffort,
          metadata: {
            continuousLearning: {
              stateId: state.id,
              definitionId: definition.id,
              runId: run.id,
            },
          },
        }).finally(() => {
          if (durationTimer) clearTimeout(durationTimer);
        }),
        new Promise<never>((_resolve, reject) => {
          durationTimer = setTimeout(() => {
            void input.interruptSessionTurn(session.id).finally(() => {
              reject(new Error("Continuous-learning review exceeded its duration limit."));
            });
          }, definition.limits.maxDurationMs);
        }),
      ]);
      if (turn.status === "interrupted") {
        return finishRun(state.id, run.id, {
          status: "cancelled",
          sessionId: session.id,
          error: null,
          receipt: null,
        });
      }
      const assistantText = await latestContinuousLearningAssistantText(
        input.store,
        session.id,
      );
      const evidence = evidenceByRun.get(run.id);
      if (!assistantText || !evidence) {
        throw new Error("The review did not produce a recommendation receipt.");
      }
      const receipt = recommendationReceipt({
        text: assistantText,
        state,
        definition,
        runId: run.id,
        evidence,
        startedAt: timestamp,
      });
      return finishRun(state.id, run.id, {
        status: receipt.status,
        sessionId: session.id,
        error: null,
        receipt,
      });
    } catch (error) {
      return finishRun(state.id, run.id, {
        status: "failed",
        sessionId: running.get(state.id)?.sessionId ?? null,
        error: error instanceof Error ? error.message : String(error),
        receipt: null,
      });
    } finally {
      running.delete(state.id);
      evidenceByRun.delete(run.id);
    }
  }

  async function cancelRun(stateIdValue: string, runId: string) {
    const active = running.get(stateIdValue);
    if (!active) return requireRun(await requireState(stateIdValue), runId);
    if (active.sessionId) await input.interruptSessionTurn(active.sessionId);
    return requireRun(await requireState(stateIdValue), runId);
  }

  async function tick(): Promise<void> {
    if (tickRunning || input.isClosing()) return;
    tickRunning = true;
    try {
      for (const state of await input.store.listDueLocalContinuousLearningStates(
        new Date().toISOString(),
      )) {
        if (running.has(state.id)) continue;
        void runNow(state.id, "schedule").catch((error) => {
          input.logger?.warn("local continuous-learning review failed", {
            stateId: state.id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    } finally {
      tickRunning = false;
    }
  }

  function start(): void {
    if (timer || input.isClosing()) return;
    timer = setInterval(() => void tick(), input.tickMs ?? 15_000);
    timer.unref?.();
    void reconcileInterruptedRuns().then(() => tick());
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  async function reconcileInterruptedRuns(): Promise<void> {
    for (const state of await list()) {
      const interrupted = state.runs.filter(
        (run) => run.status === "queued" || run.status === "running",
      );
      if (!interrupted.length) continue;
      const completedAt = new Date().toISOString();
      await input.store.upsertLocalContinuousLearningState(
        LocalContinuousLearningStateSchema.parse({
          ...state,
          runs: state.runs.map((run) => interrupted.some((item) => item.id === run.id)
            ? {
                ...run,
                status: "failed",
                error: "OpenPond closed before this local review completed.",
                completedAt,
              }
            : run),
          schedule: {
            ...state.schedule,
            lastRunAt: completedAt,
            lastRunStatus: "failed",
            updatedAt: completedAt,
          },
          updatedAt: completedAt,
        }),
      );
    }
  }

  return {
    list,
    get,
    ensure,
    patch,
    runNow,
    cancelRun,
    setConversationConsent,
    getConversations,
    start,
    stop,
    tick,
  };

  async function requireState(id: string): Promise<LocalContinuousLearningState> {
    const state = await get(id);
    if (!state) throw new Error("Local continuous-learning Saved Work was not found.");
    return state;
  }

  async function saveRun(
    state: LocalContinuousLearningState,
    run: LocalContinuousLearningRun,
    schedulePatch: { nextRunAt?: string | null } = {},
  ): Promise<LocalContinuousLearningState> {
    const timestamp = new Date().toISOString();
    const runs = [run, ...state.runs.filter((item) => item.id !== run.id)]
      .slice(0, MAX_RUN_HISTORY);
    return input.store.upsertLocalContinuousLearningState(
      LocalContinuousLearningStateSchema.parse({
        ...state,
        runs,
        schedule: {
          ...state.schedule,
          ...schedulePatch,
          updatedAt: timestamp,
        },
        updatedAt: timestamp,
      }),
    );
  }

  async function finishRun(
    id: string,
    runId: string,
    result: Pick<LocalContinuousLearningRun, "status" | "sessionId" | "receipt" | "error">,
  ): Promise<LocalContinuousLearningRun> {
    const state = await requireState(id);
    const run = requireRun(state, runId);
    const completedAt = new Date().toISOString();
    const completed = { ...run, ...result, completedAt };
    const committed = result.status === "completed" || result.status === "no_recommendation";
    const updated = await saveRun(state, completed, {
      nextRunAt: state.schedule.enabled
        ? state.schedule.nextRunAt ?? nextDailyRunAt(state.schedule.localTime, state.schedule.timezone)
        : null,
    });
    await input.store.upsertLocalContinuousLearningState(
      LocalContinuousLearningStateSchema.parse({
        ...updated,
        schedule: {
          ...updated.schedule,
          lastRunAt: completedAt,
          lastRunStatus: result.status,
          latestResultSessionId: result.sessionId,
          inputWatermark: committed
            ? result.receipt?.outputWatermark ?? updated.schedule.inputWatermark
            : updated.schedule.inputWatermark,
          updatedAt: completedAt,
        },
        updatedAt: completedAt,
      }),
    );
    return completed;
  }
}

function stateId(profileId: string, scope: string, workspaceId: string | null): string {
  const key = `${profileId}:${scope}:${workspaceId ?? "personal"}`;
  return `local_cl_${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}

function definitionFor(input: {
  existing: LocalContinuousLearningState | null;
  profileId: string;
  scope: "personal" | "my_team";
  workspaceId: string | null;
  artifact: TasksetAuthoringSkillArtifact;
  model: LocalContinuousLearningDefinition["model"] | null;
  createdAt: string;
}): LocalContinuousLearningDefinition {
  const version = (input.existing?.definitions.at(-1)?.version ?? 0) + 1;
  return {
    schemaVersion: "openpond.localSavedWorkDefinition.v1",
    id: `${stateId(input.profileId, input.scope, input.workspaceId)}:definition:${version}`,
    profileId: input.profileId,
    scope: input.scope,
    workspaceId: input.workspaceId,
    templateKey: CONTINUOUS_LEARNING_TEMPLATE_KEY,
    version,
    promptVersion: CONTINUOUS_LEARNING_RECOMMENDATION_PROMPT_VERSION,
    prompt: CONTINUOUS_LEARNING_RECOMMENDATION_PROMPT,
    policyVersion: CONTINUOUS_LEARNING_DEFAULT_POLICY_VERSION,
    skill: {
      name: "openpond-taskset-authoring",
      artifactVersion: input.artifact.artifactVersion,
      contentHash: input.artifact.contentHash,
    },
    model: input.model ?? { ...CONTINUOUS_LEARNING_DEFAULT_POLICY.model },
    limits: {
      lookbackDays: CONTINUOUS_LEARNING_DEFAULT_POLICY.lookbackDays,
      ...CONTINUOUS_LEARNING_DEFAULT_POLICY.limits,
    },
    createdAt: input.createdAt,
  };
}

function sameTemplate(
  left: LocalContinuousLearningDefinition,
  right: LocalContinuousLearningDefinition,
): boolean {
  return left.promptVersion === right.promptVersion
    && left.prompt === right.prompt
    && left.policyVersion === right.policyVersion
    && left.skill.artifactVersion === right.skill.artifactVersion
    && left.skill.contentHash === right.skill.contentHash
    && JSON.stringify(left.model) === JSON.stringify(right.model);
}

function currentDefinition(
  state: LocalContinuousLearningState | null,
): LocalContinuousLearningDefinition | null {
  if (!state) return null;
  return definitionById(state, state.currentDefinitionId);
}

function definitionById(
  state: LocalContinuousLearningState,
  id: string,
): LocalContinuousLearningDefinition {
  const definition = state.definitions.find((item) => item.id === id);
  if (!definition) throw new Error("Local Saved Work definition was not found.");
  return definition;
}

function preserveOrCalculateNextRun(
  state: LocalContinuousLearningState | null,
  localTime: string,
  timezone: string,
): string {
  if (
    state?.schedule.nextRunAt
    && state.schedule.localTime === localTime
    && state.schedule.timezone === timezone
    && Date.parse(state.schedule.nextRunAt) > Date.now()
  ) return state.schedule.nextRunAt;
  return nextDailyRunAt(localTime, timezone);
}

export function nextDailyRunAt(
  localTime: string,
  timezone: string,
  after = new Date(),
): string {
  const [hour, minute] = localTime.split(":").map(Number);
  return CronExpressionParser.parse(`${minute} ${hour} * * *`, {
    currentDate: after,
    tz: timezone,
  }).next().toDate().toISOString();
}

function consentFromSession(session: Session) {
  return LocalConversationLearningConsentSchema.safeParse(
    session.metadata?.continuousLearningConsent,
  ).data ?? null;
}

function runtimeBinding(session: Session): {
  stateId: string;
  definitionId: string;
  runId: string;
} {
  const value = session.metadata?.continuousLearning;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("get_conversations is unavailable outside continuous-learning Work.");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.stateId !== "string"
    || typeof record.definitionId !== "string"
    || typeof record.runId !== "string"
  ) throw new Error("Continuous-learning runtime binding is invalid.");
  return {
    stateId: record.stateId,
    definitionId: record.definitionId,
    runId: record.runId,
  };
}

async function collectConversations(input: {
  store: SqliteStore;
  state: LocalContinuousLearningState;
  definition: LocalContinuousLearningDefinition;
  excludedSessionId: string;
}): Promise<GetConversationsToolResult> {
  const counts = {
    notEligible: 0,
    revoked: 0,
    notCreatedByOwner: 0,
    multiParticipant: 0,
    outsideLookback: 0,
    dismissedFingerprint: 0,
    budgetBound: 0,
  };
  const cutoff = Date.now() - input.definition.limits.lookbackDays * 86_400_000;
  const sessions = (await input.store.sessionShells())
    .filter((session) => session.id !== input.excludedSessionId)
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  const eligible: Session[] = [];
  for (const session of sessions) {
    const consent = consentFromSession(session);
    if (!consent) { counts.notEligible += 1; continue; }
    if (consent.status === "revoked") { counts.revoked += 1; continue; }
    if (consent.scope !== input.state.scope) { counts.notEligible += 1; continue; }
    if (
      input.state.scope === "my_team"
      && (consent.workspaceId !== input.state.workspaceId
        || session.cloudTeamId !== input.state.workspaceId)
    ) { counts.notCreatedByOwner += 1; continue; }
    const participants = session.metadata?.participantCount;
    if (typeof participants === "number" && participants > 1) {
      counts.multiParticipant += 1;
      continue;
    }
    if (Date.parse(session.updatedAt) < cutoff) {
      counts.outsideLookback += 1;
      continue;
    }
    if (
      input.state.schedule.inputWatermark
      && session.updatedAt <= input.state.schedule.inputWatermark
    ) continue;
    eligible.push(session);
  }
  let estimatedTokens = 0;
  const conversations: GetConversationsToolResult["conversations"] = [];
  for (const session of eligible) {
    if (conversations.length >= input.definition.limits.maxConversations) {
      counts.budgetBound += 1;
      continue;
    }
    const turns = (await input.store.turnsForSession(session.id, 100))
      .filter((turn) => turn.status === "completed")
      .reverse();
    const messages: GetConversationsToolResult["conversations"][number]["messages"] = [];
    for (const turn of turns) {
      if (messages.length >= input.definition.limits.maxMessagesPerConversation) break;
      messages.push({ role: "user", text: turn.prompt.slice(0, 2_000), createdAt: turn.startedAt });
      const events = await input.store.runtimeEventsForSession(session.id, { limit: 10_000 });
      const assistant = events
        .filter((event) => event.turnId === turn.id && event.name === "assistant.delta")
        .map((event) => event.output ?? "")
        .join("")
        .trim();
      if (assistant && messages.length < input.definition.limits.maxMessagesPerConversation) {
        messages.push({
          role: "assistant",
          text: assistant.slice(0, 2_000),
          createdAt: turn.completedAt ?? turn.startedAt,
        });
      }
    }
    if (!messages.length) { counts.notEligible += 1; continue; }
    const tokens = Math.ceil(messages.reduce((sum, item) => sum + item.text.length, 0) / 4);
    if (estimatedTokens + tokens > input.definition.limits.maxEvidenceTokens) {
      counts.budgetBound += 1;
      continue;
    }
    estimatedTokens += tokens;
    const serialized = JSON.stringify(messages);
    conversations.push({
      sourceReference: {
        referenceId: `desktop:${session.id}`,
        surface: "desktop",
        scope: input.state.scope,
        experience: session.experience,
        revision: session.updatedAt,
        occurredAt: session.updatedAt,
        contentHash: createHash("sha256").update(serialized).digest("hex"),
      },
      title: session.title || null,
      messages,
    });
  }
  const proposedWatermark = conversations.at(-1)?.sourceReference.occurredAt
    ?? input.state.schedule.inputWatermark
    ?? new Date().toISOString();
  return GetConversationsToolResultSchema.parse({
    schemaVersion: GET_CONVERSATIONS_CONTRACT_VERSION,
    scope: input.state.scope,
    inputWatermark: input.state.schedule.inputWatermark,
    proposedWatermark,
    consideredSourceCount: sessions.length,
    excludedCounts: counts,
    conversations,
    emptyReason: conversations.length
      ? null
      : eligible.length
      ? "budget_exhausted"
      : Object.values(counts).some((count) => count > 0)
      ? "privacy_or_consent_filtered"
      : "no_eligible_sources",
  });
}

function recommendationReceipt(input: {
  text: string;
  state: LocalContinuousLearningState;
  definition: LocalContinuousLearningDefinition;
  runId: string;
  evidence: GetConversationsToolResult;
  startedAt: string;
}): ContinuousLearningReceipt {
  const start = input.text.indexOf(RESULT_START);
  const end = input.text.indexOf(RESULT_END);
  if (start < 0 || end <= start || input.text.indexOf(RESULT_START, start + 1) >= 0) {
    throw new Error("The model did not emit exactly one recommendation receipt.");
  }
  const output = ContinuousLearningRecommendationOutputSchema.parse(
    JSON.parse(input.text.slice(start + RESULT_START.length, end).trim()),
  );
  if (output.schemaVersion !== CONTINUOUS_LEARNING_RECOMMENDATION_CONTRACT_VERSION) {
    throw new Error("The recommendation contract version is invalid.");
  }
  if (output.scope !== input.state.scope) throw new Error("The recommendation changed scope.");
  const allowedRefs = new Set(
    input.evidence.conversations.map((item) => item.sourceReference.referenceId),
  );
  for (const recommendation of output.recommendations) {
    for (const ref of recommendation.sourceReferenceIds) {
      if (!allowedRefs.has(ref)) throw new Error(`Recommendation cited unavailable source ${ref}.`);
    }
  }
  const status = output.recommendations.length ? "completed" : "no_recommendation";
  const outputTokens = Math.ceil(input.text.length / 4);
  const durationMs = Date.now() - Date.parse(input.startedAt);
  if (outputTokens > input.definition.limits.maxOutputTokens) {
    throw new Error("The recommendation exceeded its output-token limit.");
  }
  if (durationMs > input.definition.limits.maxDurationMs) {
    throw new Error("The recommendation exceeded its duration limit.");
  }
  return {
    schemaVersion: CONTINUOUS_LEARNING_RECEIPT_CONTRACT_VERSION,
    surface: "desktop",
    scope: input.state.scope,
    scheduleDefinitionRef: input.definition.id,
    runRef: input.runId,
    promptVersion: input.definition.promptVersion,
    skill: input.definition.skill,
    evidenceContractVersion: GET_CONVERSATIONS_CONTRACT_VERSION,
    inputWatermark: input.evidence.inputWatermark,
    outputWatermark: input.evidence.proposedWatermark,
    consideredSourceCount: input.evidence.consideredSourceCount,
    excludedCounts: input.evidence.excludedCounts,
    selectedSourceReferences: input.evidence.conversations.map((item) => item.sourceReference),
    candidateFingerprints: output.recommendations.map((item) => item.candidateFingerprint),
    recommendationSummaries: output.recommendations.map((item) => ({
      candidateFingerprint: item.candidateFingerprint,
      proposedAction: item.proposedAction,
      summary: item.summary,
    })),
    model: {
      provider: input.definition.model.provider,
      model: input.definition.model.model,
    },
    usage: {
      inputTokens: 0,
      outputTokens,
      durationMs,
      costUsd: 0,
    },
    status,
    noRecommendationReason: output.noRecommendationReason,
    materializationInvoked: false,
    createdAt: new Date().toISOString(),
  };
}

function requireRun(state: LocalContinuousLearningState, runId: string): LocalContinuousLearningRun {
  const run = state.runs.find((item) => item.id === runId);
  if (!run) throw new Error("Local continuous-learning run was not found.");
  return run;
}

async function latestContinuousLearningAssistantText(
  store: SqliteStore,
  sessionId: string,
): Promise<string | null> {
  const events = await store.runtimeEventsForSession(sessionId, { limit: 10_000 });
  for (const runtimeEvent of events.reverse()) {
    if (runtimeEvent.name !== "assistant.delta") continue;
    const data = runtimeEvent.data;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const raw = (data as Record<string, unknown>).continuousLearningRawAssistantText;
      if (typeof raw === "string" && raw.trim()) return raw;
    }
    if (runtimeEvent.output?.trim()) return runtimeEvent.output;
  }
  return null;
}
