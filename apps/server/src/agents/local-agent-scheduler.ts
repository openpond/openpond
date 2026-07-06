import { execFile } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { CronExpressionParser } from "cron-parser";
import type {
  LocalAgentSchedule,
  LocalAgentScheduleRun,
  LocalAgentSchedulesResponse,
  OpenPondProfileState,
  PatchLocalAgentScheduleRequest,
  RuntimeEvent,
} from "@openpond/contracts";
import type { BackgroundWorkerQueue } from "../runtime/background-worker-queue.js";
import type { SqliteStore } from "../store/store.js";
import { event, now } from "../utils.js";

const execFileAsync = promisify(execFile);

const DEFAULT_TICK_MS = 15_000;
const DEFAULT_RECONCILE_MS = 60_000;
const INSPECT_TIMEOUT_MS = 60_000;
const RUN_TIMEOUT_MS = 30 * 60_000;
const MAX_CAPTURED_OUTPUT_CHARS = 200_000;

type LocalAgentSchedulerLogger = {
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
};

export type LocalAgentScheduleLoop = {
  start: () => void;
  stop: () => void;
  syncNow: () => Promise<LocalAgentSchedulesResponse>;
  list: (input?: { localProjectId?: string | null }) => Promise<LocalAgentSchedulesResponse>;
  patchSchedule: (
    scheduleId: string,
    payload: PatchLocalAgentScheduleRequest,
  ) => Promise<LocalAgentSchedule | null>;
  runNow: (
    scheduleId: string,
    input?: Record<string, unknown>,
  ) => Promise<{ schedule: LocalAgentSchedule; run: LocalAgentScheduleRun }>;
  listRuns: (scheduleId: string, limit?: number) => Promise<LocalAgentScheduleRun[]>;
  status: () => LocalAgentSchedulesResponse["scheduler"];
};

type AgentScheduleDefinition = {
  name: string;
  scheduleType: "cron" | "rate";
  scheduleExpression: string;
  timezone: string | null;
  targetAction: string;
  enabledByDefault: boolean;
  input: Record<string, unknown>;
  sourceHash: string;
};

type AgentManifestPayload = {
  projectName: string;
  manifestHash: string | null;
  schedules: AgentScheduleDefinition[];
};

type AgentScheduleSource = {
  id: string;
  name: string;
  agentRootPath: string;
};

export function createLocalAgentScheduleLoop(options: {
  store: SqliteStore;
  queue: BackgroundWorkerQueue;
  isClosing: () => boolean;
  loadProfileState?: () => Promise<OpenPondProfileState>;
  appendRuntimeEvent?: (runtimeEvent: RuntimeEvent) => Promise<void>;
  logger?: LocalAgentSchedulerLogger;
  tickMs?: number;
  reconcileMs?: number;
}): LocalAgentScheduleLoop {
  const tickMs = options.tickMs ?? DEFAULT_TICK_MS;
  const reconcileMs = options.reconcileMs ?? DEFAULT_RECONCILE_MS;
  const runningScheduleIds = new Set<string>();
  let interval: ReturnType<typeof setInterval> | null = null;
  let tickRunning = false;
  let lastSyncAt: string | null = null;
  let lastReconcileAtMs = 0;
  let nextTickAtMs: number | null = null;

  function schedulerStatus(): LocalAgentSchedulesResponse["scheduler"] {
    return {
      running: Boolean(interval),
      nextTickAt: nextTickAtMs === null ? null : new Date(nextTickAtMs).toISOString(),
      lastSyncAt,
      scanRunning: tickRunning,
    };
  }

  async function list(input: { localProjectId?: string | null } = {}): Promise<LocalAgentSchedulesResponse> {
    return {
      schedules: await options.store.listLocalAgentSchedules({
        localProjectId: input.localProjectId ?? null,
      }),
      scheduler: schedulerStatus(),
    };
  }

  async function reconcile(): Promise<void> {
    const sources = await listProfileScheduleSources(options.loadProfileState, options.logger);
    if (!sources) return;
    const activeSourceIds = new Set<string>();
    for (const source of sources) {
      activeSourceIds.add(source.id);
      try {
        const manifest = await inspectAgentProject(source.agentRootPath);
        const existingSchedules = await options.store.listLocalAgentSchedules({
          localProjectId: source.id,
        });
        const existingById = new Map(existingSchedules.map((schedule) => [schedule.id, schedule]));
        const seenIds: string[] = [];
        for (const definition of manifest.schedules) {
          const id = localScheduleId(source.id, definition.name);
          seenIds.push(id);
          const existing = existingById.get(id) ?? null;
          const timestamp = now();
          const enabled = existing?.enabled ?? definition.enabledByDefault;
          const previousSourceHash = existing?.sourceHash ?? null;
          const hasSourceChanged = previousSourceHash !== definition.sourceHash;
          const nextRunAt = nextRunForReconciledSchedule({
            definition,
            enabled,
            existing,
            hasSourceChanged,
          });
          const schedule: LocalAgentSchedule = {
            id,
            localProjectId: source.id,
            localProjectName: source.name,
            agentRootPath: source.agentRootPath,
            agentName: manifest.projectName,
            scheduleName: definition.name,
            scheduleType: definition.scheduleType,
            scheduleExpression: definition.scheduleExpression,
            timezone: definition.timezone,
            targetAction: definition.targetAction,
            input: definition.input,
            enabledByDefault: definition.enabledByDefault,
            enabled,
            sourceHash: definition.sourceHash,
            manifestHash: manifest.manifestHash,
            nextRunAt: enabled ? nextRunAt.value : null,
            lastRunAt: existing?.lastRunAt ?? null,
            lastRunStatus: existing?.lastRunStatus ?? null,
            lastRunId: existing?.lastRunId ?? null,
            lastError: nextRunAt.error ?? existing?.lastError ?? null,
            createdAt: existing?.createdAt ?? timestamp,
            updatedAt: timestamp,
          };
          await options.store.upsertLocalAgentSchedule(schedule);
        }
        await options.store.deleteLocalAgentSchedulesNotIn(source.id, seenIds);
      } catch (error) {
        options.logger?.warn("local agent schedule reconcile failed", {
          sourceId: source.id,
          sourceName: source.name,
          agentRootPath: source.agentRootPath,
          error: errorText(error),
        });
      }
    }
    await deleteSchedulesForInactiveSources(options.store, activeSourceIds);
    lastSyncAt = now();
    lastReconcileAtMs = Date.now();
  }

  async function runTick(forceReconcile = false): Promise<void> {
    if (tickRunning || options.isClosing()) return;
    tickRunning = true;
    try {
      if (forceReconcile || Date.now() - lastReconcileAtMs >= reconcileMs) {
        await reconcile();
      }
      const dueSchedules = await options.store.listDueLocalAgentSchedules(now());
      for (const schedule of dueSchedules) {
        if (runningScheduleIds.has(schedule.id)) continue;
        const scheduledFor = schedule.nextRunAt ?? now();
        await enqueueRun(schedule, scheduledFor, "schedule");
      }
    } finally {
      tickRunning = false;
    }
  }

  async function enqueueRun(
    schedule: LocalAgentSchedule,
    scheduledFor: string,
    trigger: LocalAgentScheduleRun["trigger"],
    inputOverride?: Record<string, unknown>,
  ): Promise<LocalAgentScheduleRun> {
    const timestamp = now();
    const run: LocalAgentScheduleRun = {
      id: randomUUID(),
      scheduleId: schedule.id,
      localProjectId: schedule.localProjectId,
      scheduleName: schedule.scheduleName,
      scheduledFor,
      trigger,
      status: "queued",
      targetAction: schedule.targetAction,
      startedAt: null,
      completedAt: null,
      exitCode: null,
      stdout: null,
      stderr: null,
      result: null,
      traceArtifactRef: null,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const inserted = await options.store.insertLocalAgentScheduleRun(run);
    runningScheduleIds.add(schedule.id);
    options.queue.enqueue(
      {
        label: "local-agent-schedule-run",
        metadata: {
          scheduleId: schedule.id,
          scheduleName: schedule.scheduleName,
          localProjectId: schedule.localProjectId,
          trigger,
          scheduledFor,
        },
      },
      async () => {
        try {
          await executeScheduleRun(schedule, inserted, inputOverride);
        } finally {
          runningScheduleIds.delete(schedule.id);
        }
      },
    );
    return inserted;
  }

  async function executeScheduleRun(
    schedule: LocalAgentSchedule,
    run: LocalAgentScheduleRun,
    inputOverride?: Record<string, unknown>,
  ): Promise<void> {
    await options.store.patchLocalAgentScheduleRun(run.id, (current) => ({
      ...current,
      status: "running",
      startedAt: now(),
      updatedAt: now(),
    }));
    await appendDiagnostic("started", `Running local schedule ${schedule.scheduleName}.`, {
      scheduleId: schedule.id,
      runId: run.id,
      localProjectId: schedule.localProjectId,
      scheduledFor: run.scheduledFor,
      trigger: run.trigger,
    });

    let finalStatus: LocalAgentScheduleRun["status"] = "failed";
    let finalError: string | null = null;
    try {
      const result = await runAgentAction(schedule, run, inputOverride);
      finalStatus = result.exitCode === 0 ? "succeeded" : "failed";
      finalError = result.exitCode === 0 ? null : result.stderr || `Action exited with code ${result.exitCode}`;
      await options.store.patchLocalAgentScheduleRun(run.id, (current) => ({
        ...current,
        status: finalStatus,
        completedAt: now(),
        exitCode: result.exitCode,
        stdout: trimOutput(result.stdout),
        stderr: trimOutput(result.stderr),
        result: result.result,
        traceArtifactRef: result.traceArtifactRef,
        error: finalError,
        updatedAt: now(),
      }));
    } catch (error) {
      finalError = errorText(error);
      await options.store.patchLocalAgentScheduleRun(run.id, (current) => ({
        ...current,
        status: "failed",
        completedAt: now(),
        error: finalError,
        updatedAt: now(),
      }));
    }

    const timestamp = now();
    await options.store.patchLocalAgentSchedule(schedule.id, (current) => ({
      ...current,
      nextRunAt: nextRunAfterCompletedRun(current, run),
      lastRunAt: timestamp,
      lastRunStatus: finalStatus,
      lastRunId: run.id,
      lastError: nextRunErrorAfterCompletedRun(current, run) ?? finalError,
      updatedAt: timestamp,
    }));
    await appendDiagnostic(
      finalStatus === "succeeded" ? "completed" : "failed",
      finalStatus === "succeeded"
        ? `Completed local schedule ${schedule.scheduleName}.`
        : `Local schedule ${schedule.scheduleName} failed.`,
      {
        scheduleId: schedule.id,
        runId: run.id,
        localProjectId: schedule.localProjectId,
        scheduledFor: run.scheduledFor,
        trigger: run.trigger,
        error: finalError,
      },
    );
  }

  async function appendDiagnostic(
    status: "started" | "completed" | "failed",
    output: string,
    data: Record<string, unknown>,
  ) {
    await options.appendRuntimeEvent?.(
      event({
        name: "diagnostic",
        source: "server",
        status,
        output,
        data: {
          kind: "local_agent_schedule",
          ...data,
        },
      }),
    ).catch((error) => {
      options.logger?.warn("local agent schedule diagnostic failed", {
        error: errorText(error),
      });
    });
  }

  return {
    start() {
      if (interval || options.isClosing()) return;
      void runTick(true).catch((error) => {
        options.logger?.warn("local agent schedule startup sync failed", {
          error: errorText(error),
        });
      });
      nextTickAtMs = Date.now() + tickMs;
      interval = setInterval(() => {
        nextTickAtMs = Date.now() + tickMs;
        void runTick().catch((error) => {
          if (options.isClosing()) return;
          options.logger?.warn("local agent schedule tick failed", {
            error: errorText(error),
          });
        });
      }, tickMs);
      interval.unref?.();
    },
    stop() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      nextTickAtMs = null;
    },
    async syncNow() {
      await runTick(true);
      return list();
    },
    list,
    async patchSchedule(scheduleId, payload) {
      const existing = await options.store.getLocalAgentSchedule(scheduleId);
      if (!existing) return null;
      const enabled = payload.enabled ?? existing.enabled;
      const nextRunAt = enabled
        ? safeNextRunAt(scheduleDefinitionFromRecord(existing), new Date())
        : { value: null, error: null };
      return options.store.patchLocalAgentSchedule(scheduleId, (schedule) => ({
        ...schedule,
        enabled,
        nextRunAt: enabled ? nextRunAt.value : null,
        lastError: nextRunAt.error,
        updatedAt: now(),
      }));
    },
    async runNow(scheduleId, input) {
      const schedule = await options.store.getLocalAgentSchedule(scheduleId);
      if (!schedule) throw new Error("Local agent schedule not found");
      const run = await enqueueRun(schedule, now(), "manual", input);
      return { schedule, run };
    },
    listRuns(scheduleId, limit) {
      return options.store.listLocalAgentScheduleRuns(scheduleId, limit);
    },
    status: schedulerStatus,
  };
}

async function listProfileScheduleSources(
  loadProfileState: (() => Promise<OpenPondProfileState>) | undefined,
  logger: LocalAgentSchedulerLogger | undefined,
): Promise<AgentScheduleSource[] | null> {
  if (!loadProfileState) return [];
  try {
    const profile = await loadProfileState();
    if (profile.mode !== "local") return [];
    if (profile.error) {
      logger?.warn("local agent schedule profile source scan skipped", { error: profile.error });
      return null;
    }
    if (!profile.repoPath || !profile.sourcePath) return [];
    return profile.agents
      .filter((agent) => agent.enabled)
      .map((agent) => ({
        id: profileScheduleSourceId(profile, agent.id),
        name: agent.id,
        agentRootPath: profileAgentRootPath(profile.sourcePath!, agent),
      }));
  } catch (error) {
    logger?.warn("local agent schedule profile source scan failed", { error: errorText(error) });
    return null;
  }
}

function profileScheduleSourceId(profile: OpenPondProfileState, agentId: string): string {
  return `profile_${stableHash({
    repoPath: profile.repoPath,
    profile: profile.activeProfile,
    agentId,
  }).slice(0, 20)}`;
}

function profileAgentRootPath(
  profileSourcePath: string,
  agent: OpenPondProfileState["agents"][number],
): string {
  return agent.id === "default"
    ? profileSourcePath
    : path.resolve(profileSourcePath, agent.path);
}

async function deleteSchedulesForInactiveSources(
  store: SqliteStore,
  activeSourceIds: Set<string>,
): Promise<void> {
  const schedules = await store.listLocalAgentSchedules();
  const inactiveSourceIds = new Set(
    schedules
      .map((schedule) => schedule.localProjectId)
      .filter((localProjectId) => !activeSourceIds.has(localProjectId)),
  );
  for (const localProjectId of inactiveSourceIds) {
    await store.deleteLocalAgentSchedulesNotIn(localProjectId, []);
  }
}

async function inspectAgentProject(agentRootPath: string): Promise<AgentManifestPayload> {
  const cli = await resolveOpenPondAgentCli(agentRootPath);
  const { stdout } = await runBunCli(
    cli,
    ["build", "--json", "--cwd", agentRootPath],
    agentRootPath,
    INSPECT_TIMEOUT_MS,
  );
  const buildPayload = parseJsonObject(stdout);
  const manifest = asRecord(buildPayload.manifest);
  const manifestHash = stringValue(readPath(buildPayload, ["inspect", "agent", "manifestHash"]));
  const projectName =
    stringValue(readPath(manifest, ["project", "name"])) ??
    path.basename(agentRootPath) ??
    "local-agent";
  return {
    projectName,
    manifestHash,
    schedules: readScheduleDefinitions(manifest),
  };
}

function readScheduleDefinitions(manifest: unknown): AgentScheduleDefinition[] {
  const schedules = Array.isArray(readPath(manifest, ["schedules"]))
    ? readPath(manifest, ["schedules"]) as unknown[]
    : [];
  return schedules.flatMap((entry) => {
    const record = asRecord(entry);
    const name = stringValue(record.name);
    if (!name) return [];
    const scheduleType = record.scheduleType === "rate" ? "rate" : "cron";
    const expression = scheduleType === "rate"
      ? stringValue(record.rate) ?? stringValue(record.scheduleExpression)
      : stringValue(record.cron) ?? stringValue(record.scheduleExpression);
    if (!expression) return [];
    const target = asRecord(record.target);
    const targetAction =
      stringValue(target.action) ??
      stringValue(record.action) ??
      stringValue(record.targetAction) ??
      "chat";
    const input = asRecord(record.input);
    const definition: Omit<AgentScheduleDefinition, "sourceHash"> = {
      name,
      scheduleType,
      scheduleExpression: unwrapScheduleExpression(expression, scheduleType),
      timezone: stringValue(record.timezone),
      targetAction,
      enabledByDefault: record.enabledByDefault === true,
      input,
    };
    return [{
      ...definition,
      sourceHash: stableHash(definition),
    }];
  });
}

async function runAgentAction(
  schedule: LocalAgentSchedule,
  run: LocalAgentScheduleRun,
  inputOverride?: Record<string, unknown>,
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  result: Record<string, unknown> | null;
  traceArtifactRef: string | null;
}> {
  const cli = await resolveOpenPondAgentCli(schedule.agentRootPath);
  const runDir = path.join(schedule.agentRootPath, ".openpond", "local-scheduler");
  await fs.mkdir(runDir, { recursive: true });
  const inputPath = path.join(runDir, `${run.id}.input.json`);
  const input = {
    channel: "schedule",
    ...schedule.input,
    ...(inputOverride ?? {}),
    context: {
      ...asRecord(schedule.input.context),
      ...asRecord(inputOverride?.context),
      localScheduleId: schedule.id,
      localScheduleRunId: run.id,
      scheduledFor: run.scheduledFor,
      trigger: run.trigger,
    },
  };
  await fs.writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`, "utf8");
  const relativeInputPath = path.relative(schedule.agentRootPath, inputPath);
  const executed = await runBunCli(
    cli,
    [
      "run",
      schedule.targetAction,
      "--json",
      "--cwd",
      schedule.agentRootPath,
      "--out-dir",
      path.join(".openpond", "local-scheduler", "artifacts"),
      "--input-file",
      relativeInputPath,
    ],
    schedule.agentRootPath,
    RUN_TIMEOUT_MS,
  );
  const outputPayload = parseJsonObjectSafe(executed.stdout);
  return {
    exitCode: executed.exitCode,
    stdout: executed.stdout,
    stderr: executed.stderr,
    result: asRecord(outputPayload?.result) ?? null,
    traceArtifactRef: stringValue(outputPayload?.traceArtifactRef),
  };
}

async function runBunCli(
  cliPath: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const env = {
    ...process.env,
    PATH: `${path.dirname(cliPath)}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  try {
    const result = await execFileAsync(resolveBunBinary(), [cliPath, ...args], {
      cwd,
      env,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: 0,
    };
  } catch (error) {
    const execError = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    return {
      stdout: typeof execError.stdout === "string" ? execError.stdout : "",
      stderr: typeof execError.stderr === "string" ? execError.stderr : errorText(error),
      exitCode: typeof execError.code === "number" ? execError.code : 1,
    };
  }
}

async function resolveOpenPondAgentCli(agentRootPath: string): Promise<string> {
  const override = process.env.OPENPOND_AGENT_CLI?.trim();
  if (override) return path.resolve(override);
  const candidates: string[] = [];
  for (const basePath of ancestorPaths(agentRootPath)) {
    candidates.push(path.join(basePath, "node_modules", ".bin", "openpond-agent"));
  }
  for (const basePath of ancestorPaths(process.cwd())) {
    candidates.push(path.join(basePath, "node_modules", ".bin", "openpond-agent"));
  }
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (await fileExists(candidate)) return candidate;
  }
  throw new Error("openpond-agent CLI was not found in node_modules/.bin");
}

function ancestorPaths(startPath: string): string[] {
  const paths: string[] = [];
  let current = path.resolve(startPath);
  while (true) {
    paths.push(current);
    const parent = path.dirname(current);
    if (parent === current) return paths;
    current = parent;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() || stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function resolveBunBinary(): string {
  return process.env.BUN_BINARY?.trim() || "bun";
}

function safeNextRunAt(
  schedule: Pick<AgentScheduleDefinition, "scheduleType" | "scheduleExpression" | "timezone">,
  currentDate: Date | string | null,
): { value: string | null; error: string | null } {
  try {
    return { value: nextRunAt(schedule, currentDate), error: null };
  } catch (error) {
    return { value: null, error: errorText(error) };
  }
}

function nextRunAt(
  schedule: Pick<AgentScheduleDefinition, "scheduleType" | "scheduleExpression" | "timezone">,
  currentDate: Date | string | null,
): string {
  const baseDate = dateAfter(currentDate);
  if (schedule.scheduleType === "rate") {
    return new Date(baseDate.getTime() + parseRateIntervalMs(schedule.scheduleExpression)).toISOString();
  }
  const expression = normalizeCronExpression(schedule.scheduleExpression);
  const interval = CronExpressionParser.parse(expression, {
    currentDate: baseDate,
    ...(schedule.timezone ? { tz: schedule.timezone } : {}),
  });
  return interval.next().toDate().toISOString();
}

function dateAfter(value: Date | string | null): Date {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return new Date(Math.max(value.getTime(), Date.now()));
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) {
      return new Date(Math.max(parsed.getTime(), Date.now()));
    }
  }
  return new Date();
}

function parseRateIntervalMs(expression: string): number {
  const normalized = unwrapScheduleExpression(expression, "rate")
    .trim()
    .replace(/\s+/g, " ");
  const compact = /^(\d+)\s*([a-z]+)$/i.exec(normalized);
  if (!compact) throw new Error(`Invalid rate expression: ${expression}`);
  const count = Number.parseInt(compact[1]!, 10);
  if (!Number.isFinite(count) || count <= 0) {
    throw new Error(`Invalid rate count: ${expression}`);
  }
  const unit = compact[2]!.toLowerCase().replace(/s$/, "");
  const unitMs =
    unit === "second" || unit === "sec" || unit === "s" ? 1_000 :
    unit === "minute" || unit === "min" || unit === "m" ? 60_000 :
    unit === "hour" || unit === "hr" || unit === "h" ? 60 * 60_000 :
    unit === "day" || unit === "d" ? 24 * 60 * 60_000 :
    null;
  if (!unitMs) throw new Error(`Unsupported rate unit: ${expression}`);
  return count * unitMs;
}

function normalizeCronExpression(expression: string): string {
  const normalized = unwrapScheduleExpression(expression, "cron")
    .trim()
    .replace(/\?/g, "*")
    .replace(/\s+/g, " ");
  const fields = normalized.split(" ");
  if (fields.length === 6 && /^\d{4}$/.test(fields[5]!)) {
    return fields.slice(0, 5).join(" ");
  }
  if (fields.length === 7) {
    return fields.slice(0, 6).join(" ");
  }
  return normalized;
}

function unwrapScheduleExpression(expression: string, type: "cron" | "rate"): string {
  const trimmed = expression.trim();
  const wrapped = new RegExp(`^${type}\\((.*)\\)$`, "i").exec(trimmed);
  return wrapped ? wrapped[1]!.trim() : trimmed;
}

function scheduleDefinitionFromRecord(schedule: LocalAgentSchedule): AgentScheduleDefinition {
  return {
    name: schedule.scheduleName,
    scheduleType: schedule.scheduleType,
    scheduleExpression: schedule.scheduleExpression,
    timezone: schedule.timezone,
    targetAction: schedule.targetAction,
    enabledByDefault: schedule.enabledByDefault,
    input: schedule.input,
    sourceHash: schedule.sourceHash,
  };
}

function nextRunForReconciledSchedule(input: {
  definition: AgentScheduleDefinition;
  enabled: boolean;
  existing: LocalAgentSchedule | null;
  hasSourceChanged: boolean;
}): { value: string | null; error: string | null } {
  if (!input.enabled) return { value: null, error: null };
  if (!input.hasSourceChanged && input.existing?.nextRunAt && !input.existing.lastError) {
    return { value: input.existing.nextRunAt, error: null };
  }
  return safeNextRunAt(input.definition, new Date());
}

function nextRunAfterCompletedRun(
  schedule: LocalAgentSchedule,
  run: LocalAgentScheduleRun,
): string | null {
  if (!schedule.enabled) return null;
  if (run.trigger === "manual") return schedule.nextRunAt;
  return safeNextRunAt(scheduleDefinitionFromRecord(schedule), new Date()).value;
}

function nextRunErrorAfterCompletedRun(
  schedule: LocalAgentSchedule,
  run: LocalAgentScheduleRun,
): string | null {
  if (!schedule.enabled || run.trigger === "manual") return null;
  return safeNextRunAt(scheduleDefinitionFromRecord(schedule), new Date()).error;
}

function localScheduleId(localProjectId: string, scheduleName: string): string {
  return `local_schedule_${stableHash({ localProjectId, scheduleName }).slice(0, 24)}`;
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  const record = asRecord(parsed);
  if (!record) throw new Error("Expected JSON object");
  return record;
}

function parseJsonObjectSafe(value: string): Record<string, unknown> | null {
  try {
    return parseJsonObject(value.trim());
  } catch {
    return null;
  }
}

function readPath(value: unknown, pathParts: string[]): unknown {
  let current = value;
  for (const part of pathParts) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[part];
  }
  return current;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return typeof error === "string" ? error : String(error);
}

function trimOutput(value: string): string {
  if (value.length <= MAX_CAPTURED_OUTPUT_CHARS) return value;
  return `${value.slice(0, MAX_CAPTURED_OUTPUT_CHARS)}\n[truncated]`;
}
