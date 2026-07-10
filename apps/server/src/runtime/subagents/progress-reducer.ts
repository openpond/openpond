import {
  SubagentProgressSchema,
  type RuntimeEvent,
  type Session,
  type SubagentExplorationSteeringPolicy,
  type SubagentProgress,
  type SubagentProgressPhase,
  type SubagentRun,
  type SubagentValidationAttempt,
  type WorkspaceToolRequest,
  type WorkspaceToolResult,
} from "@openpond/contracts";
import {
  parseNativeToolArguments,
  type NativeModelToolCall,
  type NativeModelToolResult,
} from "../../openpond/native-tool-calls.js";
import {
  booleanFromRecord,
  numberFromRecord,
  recordFromUnknown,
  stringFromRecord,
  truncateForModelAside,
  uniqueNonEmptyStrings,
} from "../turns/value-utils.js";

const SUBAGENT_READ_ACTIONS = new Set<string>([
  "resource_read",
  "read_files",
  "sandbox_read_file",
  "sandbox_list_files",
  "git_status",
  "git_diff",
  "sandbox_git_status",
  "sandbox_git_diff",
  "sandbox_git_export_patch",
  "web_fetch",
]);
const SUBAGENT_SEARCH_ACTIONS = new Set<string>([
  "resource_search",
  "search_files",
  "sandbox_search_files",
  "web_search",
]);
const SUBAGENT_MUTATING_ACTIONS = new Set<string>([
  "write_file",
  "write_files",
  "edit_file",
  "delete_file",
  "sandbox_write_file",
  "sandbox_edit_file",
  "sandbox_delete_file",
  "sandbox_mkdir",
  "sandbox_move_file",
  "sandbox_upload_file",
  "sandbox_git_commit",
  "sandbox_git_apply_patch_local",
]);
const SUBAGENT_COMMAND_ACTIONS = new Set<string>([
  "exec_command",
  "sandbox_exec",
  "sandbox_run_action",
  "run_sandbox_template",
]);

export const SUBAGENT_PROGRESS_PROJECTION_METADATA_KEY = "subagentProgressProjection";

export type SubagentProgressProjectionState = {
  version: 1;
  afterSequence: number;
  readCounts: Record<string, number>;
  searchCounts: Record<string, number>;
  commandCounts: Record<string, number>;
  startedArgsByToolCallId: Record<string, Record<string, unknown>>;
  processedResultIds: string[];
};

export type SubagentProgressProjection = {
  progress: SubagentProgress;
  state: SubagentProgressProjectionState;
};

export function subagentProgressProjectionStateFromRun(run: SubagentRun): SubagentProgressProjectionState {
  const raw = recordFromUnknown(run.metadata?.[SUBAGENT_PROGRESS_PROJECTION_METADATA_KEY]);
  if (!raw || raw.version !== 1) return emptySubagentProgressProjectionState();
  return {
    version: 1,
    afterSequence: nonNegativeInteger(raw.afterSequence),
    readCounts: boundedPositiveCountRecord(raw.readCounts),
    searchCounts: boundedPositiveCountRecord(raw.searchCounts),
    commandCounts: boundedPositiveCountRecord(raw.commandCounts),
    startedArgsByToolCallId: boundedRecordMap(raw.startedArgsByToolCallId, 500),
    processedResultIds: uniqueNonEmptyStrings(stringArrayFromUnknown(raw.processedResultIds)).slice(-2_000),
  };
}

export function subagentProgressFromRuntimeEvents(input: {
  run: SubagentRun;
  events: RuntimeEvent[];
  phase: SubagentProgressPhase | null;
  latestMeaningfulActivity: string | null;
  currentBlocker: string | null;
}): SubagentProgress {
  return subagentProgressProjectionFromRuntimeEvents({
    ...input,
    state: emptySubagentProgressProjectionState(),
  }).progress;
}

export function subagentProgressProjectionFromRuntimeEvents(input: {
  run: SubagentRun;
  events: RuntimeEvent[];
  state: SubagentProgressProjectionState;
  phase: SubagentProgressPhase | null;
  latestMeaningfulActivity: string | null;
  currentBlocker: string | null;
}): SubagentProgressProjection {
  const base = SubagentProgressSchema.parse(input.run.progress ?? {});
  const inspectedFiles: string[] = [...base.inspectedFiles];
  const inspectedResources: string[] = [...base.inspectedResources];
  const changedFiles: string[] = [...base.changedFiles];
  const validationAttempts: SubagentValidationAttempt[] = [...base.validationAttempts];
  const readCounts = new Map<string, number>(Object.entries(input.state.readCounts));
  const searchCounts = new Map<string, number>(Object.entries(input.state.searchCounts));
  const commandCounts = new Map<string, number>(Object.entries(input.state.commandCounts));
  const startedArgsByToolCallId = new Map<string, Record<string, unknown>>(
    Object.entries(input.state.startedArgsByToolCallId),
  );
  const processedResultIds = new Set<string>(input.state.processedResultIds);
  const validationCommands = new Set(input.run.workerBrief.validationCommands.map(normalizeCommandKey));
  let latestMeaningfulActivity = input.latestMeaningfulActivity ?? base.latestMeaningfulActivity ?? null;
  let currentBlocker = input.currentBlocker ?? base.currentBlocker ?? null;
  const latestPriorValidation = base.validationAttempts.at(-1) ?? null;
  if (latestPriorValidation?.status === "failed") {
    currentBlocker = `Validation failed: ${truncateForModelAside(latestPriorValidation.command, 220)}`;
  }
  let updatedAt = base.updatedAt;
  let lastInferredPhase: SubagentProgressPhase = base.phase ?? "orient";
  let afterSequence = input.state.afterSequence;

  for (const item of input.events) {
    if (item.sequence !== undefined) afterSequence = Math.max(afterSequence, item.sequence);
    const data = recordFromUnknown(item.data);
    if (item.name === "tool.started") {
      const toolCallId = data ? stringFromRecord(data, "toolCallId") : null;
      if (toolCallId) startedArgsByToolCallId.set(toolCallId, item.args ?? {});
      continue;
    }

    if (
      item.name !== "tool.completed" &&
      item.name !== "workspace_action_result" &&
      item.name !== "command.output"
    ) {
      continue;
    }

    const action = item.action ?? (data ? stringFromRecord(data, "tool") : null);
    if (!action) continue;
    const resultId = subagentProgressResultId(item, data);
    if (processedResultIds.has(resultId)) continue;
    processedResultIds.add(resultId);

    const resultData = subagentProgressResultData(data);
    const args = subagentProgressEventArgs(item, data, startedArgsByToolCallId);
    const completedToolCallId = data ? stringFromRecord(data, "toolCallId") : null;
    if (completedToolCallId) startedArgsByToolCallId.delete(completedToolCallId);
    if (item.timestamp) updatedAt = item.timestamp;

    const resourceRefs = subagentResourceRefsFromEvent(data, resultData);
    inspectedResources.push(...resourceRefs);
    inspectedFiles.push(...resourceRefs.map(filePathFromResourceRef).filter((value): value is string => Boolean(value)));

    if (SUBAGENT_SEARCH_ACTIONS.has(action)) {
      const key = subagentSearchKey(action, args, resultData);
      if (key) incrementCount(searchCounts, key);
      const searchPaths = subagentPathsFromSearchResult(resultData);
      inspectedFiles.push(...searchPaths);
      latestMeaningfulActivity = searchPaths.length
        ? `Searched workspace context and found ${searchPaths.length} file reference${searchPaths.length === 1 ? "" : "s"}.`
        : `Searched workspace context: ${key ?? action}.`;
      lastInferredPhase = "orient";
    }

    if (SUBAGENT_READ_ACTIONS.has(action)) {
      const readTargets = uniqueNonEmptyStrings([
        ...subagentPathsFromArgs(args),
        ...subagentPathsFromReadResult(resultData),
        ...resourceRefs,
      ]);
      inspectedFiles.push(...readTargets.map((value) => filePathFromResourceRef(value) ?? value));
      const key = subagentReadKey(action, args, readTargets);
      if (key) incrementCount(readCounts, key);
      latestMeaningfulActivity = readTargets.length
        ? `Inspected ${readTargets.slice(0, 3).join(", ")}.`
        : `Inspected workspace context with ${action}.`;
      lastInferredPhase = "orient";
    }

    if (SUBAGENT_MUTATING_ACTIONS.has(action)) {
      const paths = uniqueNonEmptyStrings([
        ...subagentPathsFromArgs(args),
        ...subagentChangedPathsFromResult(resultData),
      ]);
      changedFiles.push(...paths);
      if (paths.length > 0) {
        latestMeaningfulActivity = `Changed ${paths.slice(0, 3).join(", ")}.`;
      } else {
        latestMeaningfulActivity = `Ran mutating workspace action ${action}.`;
      }
      lastInferredPhase = "edit";
    }

    if (SUBAGENT_COMMAND_ACTIONS.has(action)) {
      const attempt = subagentValidationAttemptFromEvent({
        action,
        event: item,
        args,
        resultData,
        validationCommands,
      });
      const command = attempt?.command ?? subagentCommandFromEvent(args, resultData);
      if (command) incrementCount(commandCounts, normalizeCommandKey(command));
      if (attempt) {
        validationAttempts.push(attempt);
        latestMeaningfulActivity = `Ran validation command: ${truncateForModelAside(attempt.command, 180)} (${attempt.status}).`;
        currentBlocker = attempt.status === "failed"
          ? `Validation failed: ${truncateForModelAside(attempt.command, 220)}`
          : attempt.status === "passed"
            ? null
            : currentBlocker;
        lastInferredPhase = "validate";
      }
    }

    if (item.status === "failed" && !currentBlocker) {
      currentBlocker = item.error ?? item.output ?? `${action} failed.`;
      latestMeaningfulActivity = `${action} failed.`;
      lastInferredPhase = "report";
    }
  }

  const repeatedSearches = uniqueNonEmptyStrings([
    ...base.repeatedSearches,
    ...repeatedKeys(searchCounts),
  ]);
  const repeatedReads = uniqueNonEmptyStrings([
    ...base.repeatedReads,
    ...repeatedKeys(readCounts),
  ]);
  const repeatedCommands = uniqueNonEmptyStrings([
    ...base.repeatedCommands,
    ...repeatedKeys(commandCounts),
  ]);
  const dedupedValidationAttempts = uniqueValidationAttempts(validationAttempts);
  const inferredPhase = input.phase ?? inferSubagentProgressPhase({
    basePhase: base.phase,
    lastInferredPhase,
    hasValidation: dedupedValidationAttempts.length > 0,
    hasChanges: changedFiles.length > 0 || base.patchRefs.length > 0,
    hasBlocker: Boolean(currentBlocker),
  });

  const progress = SubagentProgressSchema.parse({
    ...base,
    phase: inferredPhase,
    inspectedFiles: uniqueNonEmptyStrings(inspectedFiles).slice(0, 500),
    inspectedResources: uniqueNonEmptyStrings(inspectedResources).slice(0, 500),
    repeatedSearches: repeatedSearches.slice(0, 200),
    repeatedReads: repeatedReads.slice(0, 200),
    repeatedCommands: repeatedCommands.slice(0, 200),
    changedFiles: uniqueNonEmptyStrings(changedFiles).slice(0, 500),
    validationAttempts: dedupedValidationAttempts.slice(-100),
    latestMeaningfulActivity,
    currentBlocker,
    updatedAt,
  });
  return {
    progress,
    state: {
      version: 1,
      afterSequence,
      readCounts: boundedCountMap(readCounts, 1_000),
      searchCounts: boundedCountMap(searchCounts, 1_000),
      commandCounts: boundedCountMap(commandCounts, 1_000),
      startedArgsByToolCallId: Object.fromEntries([...startedArgsByToolCallId.entries()].slice(-500)),
      processedResultIds: [...processedResultIds].slice(-2_000),
    },
  };
}

function emptySubagentProgressProjectionState(): SubagentProgressProjectionState {
  return {
    version: 1,
    afterSequence: 0,
    readCounts: {},
    searchCounts: {},
    commandCounts: {},
    startedArgsByToolCallId: {},
    processedResultIds: [],
  };
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function boundedPositiveCountRecord(value: unknown): Record<string, number> {
  const record = recordFromUnknown(value);
  if (!record) return {};
  const entries: Array<[string, number]> = [];
  for (const [key, count] of Object.entries(record)) {
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count <= 0) continue;
    entries.push([key, count]);
    if (entries.length >= 1_000) break;
  }
  return Object.fromEntries(entries);
}

function boundedRecordMap(value: unknown, limit: number): Record<string, Record<string, unknown>> {
  const record = recordFromUnknown(value);
  if (!record) return {};
  const entries: Array<[string, Record<string, unknown>]> = [];
  for (const [key, candidate] of Object.entries(record)) {
    const parsed = recordFromUnknown(candidate);
    if (!parsed) continue;
    entries.push([key, parsed]);
    if (entries.length >= limit) break;
  }
  return Object.fromEntries(entries);
}

function boundedCountMap(counts: Map<string, number>, limit: number): Record<string, number> {
  return Object.fromEntries([...counts.entries()].slice(-limit));
}

function subagentProgressResultId(item: RuntimeEvent, data: Record<string, unknown> | null): string {
  const workspaceToolCallId = data ? stringFromRecord(data, "workspaceToolCallId") : null;
  if (workspaceToolCallId) return `workspace:${workspaceToolCallId}`;
  const toolCallId = data ? stringFromRecord(data, "toolCallId") : null;
  if (toolCallId) return `tool:${toolCallId}`;
  return item.id;
}

function subagentProgressResultData(data: Record<string, unknown> | null): Record<string, unknown> | null {
  return recordFromUnknown(data?.result) ?? data;
}

function subagentProgressEventArgs(
  item: RuntimeEvent,
  data: Record<string, unknown> | null,
  startedArgsByToolCallId: Map<string, Record<string, unknown>>,
): Record<string, unknown> {
  if (item.args) return item.args;
  const toolCallId = data ? stringFromRecord(data, "toolCallId") : null;
  return toolCallId ? startedArgsByToolCallId.get(toolCallId) ?? {} : {};
}

function subagentResourceRefsFromEvent(
  data: Record<string, unknown> | null,
  resultData: Record<string, unknown> | null,
): string[] {
  const refs: string[] = [];
  refs.push(...stringArrayFromUnknown(data?.resourceRefs));
  const resource = recordFromUnknown(resultData?.resource);
  const resourceRef = resource ? stringFromRecord(resource, "ref") : null;
  if (resourceRef) refs.push(resourceRef);
  const result = recordFromUnknown(resultData?.result);
  const items = Array.isArray(result?.items) ? result.items : Array.isArray(resultData?.items) ? resultData.items : [];
  for (const item of items) {
    const ref = recordFromUnknown(item) ? stringFromRecord(recordFromUnknown(item)!, "ref") : null;
    if (ref) refs.push(ref);
  }
  return uniqueNonEmptyStrings(refs);
}

function filePathFromResourceRef(ref: string): string | null {
  const normalized = ref.trim();
  for (const prefix of ["workspace:file:", "sandbox:file:"]) {
    if (normalized.startsWith(prefix)) return normalized.slice(prefix.length).replace(/^\/workspace\//, "");
  }
  return null;
}

function subagentPathsFromArgs(args: Record<string, unknown>): string[] {
  const paths: string[] = [];
  paths.push(...stringArrayFromUnknown(args.paths));
  for (const key of ["path", "fromPath", "toPath", "ref"]) {
    const value = stringFromRecord(args, key);
    if (value) paths.push(filePathFromResourceRef(value) ?? value);
  }
  const files = recordFromUnknown(args.files);
  if (files) paths.push(...Object.keys(files));
  return uniqueNonEmptyStrings(paths);
}

function subagentPathsFromSearchResult(resultData: Record<string, unknown> | null): string[] {
  const paths: string[] = [];
  const result = recordFromUnknown(resultData?.result);
  for (const item of [
    ...(Array.isArray(result?.items) ? result.items : []),
    ...(Array.isArray(resultData?.items) ? resultData.items : []),
    ...(Array.isArray(resultData?.matches) ? resultData.matches : []),
  ]) {
    const record = recordFromUnknown(item);
    if (!record) continue;
    const ref = stringFromRecord(record, "ref");
    const pathValue = stringFromRecord(record, "path") ?? stringFromRecord(record, "filePath");
    if (ref) paths.push(filePathFromResourceRef(ref) ?? ref);
    if (pathValue) paths.push(pathValue);
  }
  return uniqueNonEmptyStrings(paths);
}

function subagentPathsFromReadResult(resultData: Record<string, unknown> | null): string[] {
  const paths: string[] = [];
  const resource = recordFromUnknown(resultData?.resource);
  const resourceRef = resource ? stringFromRecord(resource, "ref") : null;
  if (resourceRef) paths.push(filePathFromResourceRef(resourceRef) ?? resourceRef);
  const file = recordFromUnknown(resultData?.file);
  const filePath = file ? stringFromRecord(file, "path") : null;
  if (filePath) paths.push(filePath);
  for (const item of Array.isArray(resultData?.files) ? resultData.files : []) {
    if (typeof item === "string") {
      paths.push(item);
      continue;
    }
    const record = recordFromUnknown(item);
    const pathValue = record ? stringFromRecord(record, "path") ?? stringFromRecord(record, "filePath") : null;
    if (pathValue) paths.push(pathValue);
  }
  const status = recordFromUnknown(resultData?.status) ?? resultData;
  for (const item of Array.isArray(status?.files) ? status.files : []) {
    const record = recordFromUnknown(item);
    const pathValue = record ? stringFromRecord(record, "path") : null;
    if (pathValue) paths.push(pathValue);
  }
  return uniqueNonEmptyStrings(paths);
}

function subagentChangedPathsFromResult(resultData: Record<string, unknown> | null): string[] {
  const paths = subagentPathsFromReadResult(resultData);
  const preview = recordFromUnknown(resultData?.preview);
  for (const key of ["path", "filePath"]) {
    const value = preview ? stringFromRecord(preview, key) : null;
    if (value) paths.push(value);
  }
  return uniqueNonEmptyStrings(paths);
}

function subagentSearchKey(
  action: string,
  args: Record<string, unknown>,
  resultData: Record<string, unknown> | null,
): string | null {
  const query = stringFromRecord(args, "query")
    ?? stringFromRecord(recordFromUnknown(resultData?.result) ?? {}, "query")
    ?? stringFromRecord(resultData ?? {}, "query");
  return query ? `${action}:${query.trim().toLowerCase()}` : action;
}

function subagentReadKey(action: string, args: Record<string, unknown>, readTargets: string[]): string | null {
  const ref = stringFromRecord(args, "ref");
  if (ref) return `${action}:${ref}`;
  if (readTargets.length > 0) return `${action}:${readTargets.join(",")}`;
  return action;
}

function subagentValidationAttemptFromEvent(input: {
  action: string;
  event: RuntimeEvent;
  args: Record<string, unknown>;
  resultData: Record<string, unknown> | null;
  validationCommands: Set<string>;
}): SubagentValidationAttempt | null {
  const command = subagentCommandFromEvent(input.args, input.resultData);
  if (!command || !shouldTrackSubagentValidationCommand(command, input.validationCommands)) return null;
  const commandRecord = subagentCommandRecord(input.resultData);
  const output = subagentCommandOutput(input.event, input.resultData, commandRecord);
  const exitCode = numberFromRecord(input.resultData ?? {}, "exitCode")
    ?? numberFromRecord(commandRecord ?? {}, "exitCode");
  const status = subagentValidationStatus({
    eventStatus: input.event.status ?? null,
    commandStatus: commandRecord ? stringFromRecord(commandRecord, "status") : null,
    exitCode,
    output,
    timedOut: Boolean(booleanFromRecord(input.resultData ?? {}, "timedOut")),
    command,
  });
  const timing = recordFromUnknown(input.resultData?.workspaceToolTiming);
  return {
    command,
    status,
    exitCode,
    outputSummary: summarizeSubagentCommandOutput(output),
    startedAt: timing ? stringFromRecord(timing, "startedAt") : null,
    completedAt: timing ? stringFromRecord(timing, "completedAt") ?? input.event.timestamp : input.event.timestamp,
  };
}

function subagentCommandFromEvent(
  args: Record<string, unknown>,
  resultData: Record<string, unknown> | null,
): string | null {
  const commandRecord = subagentCommandRecord(resultData);
  return (commandRecord ? stringFromRecord(commandRecord, "command") : null)
    ?? stringFromRecord(resultData ?? {}, "command")
    ?? stringFromRecord(args, "command");
}

function subagentCommandRecord(resultData: Record<string, unknown> | null): Record<string, unknown> | null {
  return recordFromUnknown(resultData?.command) ?? recordFromUnknown(resultData?.process);
}

function subagentCommandOutput(
  eventItem: RuntimeEvent,
  resultData: Record<string, unknown> | null,
  commandRecord: Record<string, unknown> | null,
): string {
  return uniqueNonEmptyStrings([
    eventItem.output ?? "",
    eventItem.error ?? "",
    commandRecord ? stringFromRecord(commandRecord, "output") ?? "" : "",
    stringFromRecord(resultData ?? {}, "output") ?? "",
    stringFromRecord(resultData ?? {}, "stdout") ?? "",
    stringFromRecord(resultData ?? {}, "stderr") ?? "",
  ]).join("\n");
}

function shouldTrackSubagentValidationCommand(command: string, validationCommands: Set<string>): boolean {
  const normalized = normalizeCommandKey(command);
  if (validationCommands.has(normalized)) return true;
  return /\b(bun|npm|pnpm|yarn)\s+(run\s+)?(test|typecheck|lint|build|check)\b/i.test(command) ||
    /\b(vitest|jest|pytest|cargo\s+test|go\s+test|tsc|eslint|ruff|mypy)\b/i.test(command) ||
    /\b(test|typecheck|lint|build|check)s?\b/i.test(command);
}

function subagentValidationStatus(input: {
  eventStatus: RuntimeEvent["status"] | null;
  commandStatus: string | null;
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  command: string;
}): SubagentValidationAttempt["status"] {
  const commandStatus = input.commandStatus?.toLowerCase() ?? "";
  if (input.timedOut || commandStatus === "failed" || commandStatus === "timed_out" || commandStatus === "stopped") {
    return "failed";
  }
  if (input.eventStatus === "failed") return "failed";
  if (typeof input.exitCode === "number" && input.exitCode !== 0) return "failed";
  if (subagentValidationOutputLooksFailed(input.output, input.command)) return "failed";
  if (typeof input.exitCode === "number" && input.exitCode === 0) return "passed";
  if (commandStatus === "succeeded" || commandStatus === "completed") return "passed";
  if (subagentValidationOutputLooksPassed(input.output)) return "passed";
  return "unknown";
}

function subagentValidationOutputLooksFailed(output: string, command: string): boolean {
  const text = output.toLowerCase();
  if (!text.trim()) return false;
  if (/\b(?:cannot find module|typeerror:|syntaxerror:|referenceerror:|assertionerror|not ok)\b/i.test(output)) {
    return true;
  }
  if (/\b(?:test|tests|suite|suites)\s+failed\b/i.test(output)) return true;
  if (/\b[1-9]\d*\s+(?:fail|failed|failing|errors?)\b/i.test(output)) return true;
  if (/\bfailed:\s*[1-9]\d*\b/i.test(output)) return true;
  return shouldTrackSubagentValidationCommand(command, new Set()) &&
    /\b(fail(?:ed|ure|ing)?|error:|errors?:)\b/i.test(output) &&
    !/\b0\s+(?:fail|failed|failing|errors?)\b/i.test(output);
}

function subagentValidationOutputLooksPassed(output: string): boolean {
  return /\b(all tests passed|tests? passed|0 fail|0 errors?|passed)\b/i.test(output);
}

function summarizeSubagentCommandOutput(output: string): string | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  return truncateForModelAside(trimmed.replace(/\n{3,}/g, "\n\n"), 2000);
}

function normalizeCommandKey(command: string): string {
  return command.trim().replace(/\s+/g, " ").toLowerCase();
}

function uniqueValidationAttempts(attempts: SubagentValidationAttempt[]): SubagentValidationAttempt[] {
  const seen = new Set<string>();
  const result: SubagentValidationAttempt[] = [];
  for (const attempt of attempts) {
    const key = [
      normalizeCommandKey(attempt.command),
      attempt.completedAt ?? "",
      attempt.exitCode ?? "",
      attempt.status,
      attempt.outputSummary ?? "",
    ].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(attempt);
  }
  return result;
}

function inferSubagentProgressPhase(input: {
  basePhase: SubagentProgressPhase;
  lastInferredPhase: SubagentProgressPhase;
  hasValidation: boolean;
  hasChanges: boolean;
  hasBlocker: boolean;
}): SubagentProgressPhase {
  if (input.basePhase === "submitted") return "submitted";
  if (input.hasBlocker) return "report";
  if (input.lastInferredPhase !== "orient") return input.lastInferredPhase;
  if (input.hasValidation) return "validate";
  if (input.hasChanges) return "edit";
  return input.basePhase ?? "orient";
}

function incrementCount(map: Map<string, number>, key: string): void {
  const normalized = key.trim();
  if (!normalized) return;
  map.set(normalized, (map.get(normalized) ?? 0) + 1);
}

function repeatedKeys(map: Map<string, number>): string[] {
  return [...map.entries()].filter(([, count]) => count > 1).map(([key]) => key);
}

function stringArrayFromUnknown(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

export type SubagentToolLoopSteeringTracker = {
  policy: SubagentExplorationSteeringPolicy;
  searches: Map<string, number>;
  reads: Map<string, number>;
  commands: Map<string, number>;
  deliveredKeys: Set<string>;
};

export function createSubagentToolLoopSteeringTracker(
  policy: SubagentExplorationSteeringPolicy,
): SubagentToolLoopSteeringTracker {
  return {
    policy,
    searches: new Map(),
    reads: new Map(),
    commands: new Map(),
    deliveredKeys: new Set(),
  };
}

export function subagentToolLoopSteeringMessagesForNativeResults(input: {
  session: Session;
  toolCalls: NativeModelToolCall[];
  results: NativeModelToolResult[];
  tracker: SubagentToolLoopSteeringTracker;
}): string[] {
  if (!input.session.subagentRunId) return [];
  const argsByToolCallId = new Map<string, Record<string, unknown>>();
  for (const call of input.toolCalls) {
    try {
      argsByToolCallId.set(call.id, parseNativeToolArguments(call));
    } catch {
      argsByToolCallId.set(call.id, {});
    }
  }
  return input.results.flatMap((result) =>
    subagentToolLoopSteeringMessagesForAction({
      session: input.session,
      action: result.name,
      args: argsByToolCallId.get(result.toolCallId) ?? {},
      resultData: recordFromUnknown(result.data),
      tracker: input.tracker,
    }),
  );
}

export function subagentToolLoopSteeringMessagesForWorkspaceResult(input: {
  session: Session;
  request: WorkspaceToolRequest;
  result: WorkspaceToolResult;
  tracker: SubagentToolLoopSteeringTracker;
}): string[] {
  if (!input.session.subagentRunId) return [];
  return subagentToolLoopSteeringMessagesForAction({
    session: input.session,
    action: input.result.action,
    args: input.request.args,
    resultData: recordFromUnknown(input.result.data),
    tracker: input.tracker,
  });
}

function subagentToolLoopSteeringMessagesForAction(input: {
  session: Session;
  action: string;
  args: Record<string, unknown>;
  resultData: Record<string, unknown> | null;
  tracker: SubagentToolLoopSteeringTracker;
}): string[] {
  if (!input.tracker.policy.enabled) return [];
  const repeated: Array<{ kind: "search" | "read" | "command"; key: string }> = [];
  if (SUBAGENT_SEARCH_ACTIONS.has(input.action)) {
    const key = subagentSearchKey(input.action, input.args, input.resultData);
    if (key && incrementSteeringCount(input.tracker.searches, key) >= input.tracker.policy.repeatedSearchThreshold) {
      repeated.push({ kind: "search", key });
    }
  }
  if (SUBAGENT_READ_ACTIONS.has(input.action)) {
    const readTargets = uniqueNonEmptyStrings([
      ...subagentPathsFromArgs(input.args),
      ...subagentPathsFromReadResult(input.resultData),
    ]);
    const key = subagentReadKey(input.action, input.args, readTargets);
    if (key && incrementSteeringCount(input.tracker.reads, key) >= input.tracker.policy.repeatedReadThreshold) {
      repeated.push({ kind: "read", key });
    }
  }
  if (SUBAGENT_COMMAND_ACTIONS.has(input.action)) {
    const command = subagentCommandFromEvent(input.args, input.resultData);
    const key = command ? normalizeCommandKey(command) : null;
    if (key && incrementSteeringCount(input.tracker.commands, key) >= input.tracker.policy.repeatedCommandThreshold) {
      repeated.push({ kind: "command", key });
    }
  }
  const messages: string[] = [];
  for (const item of repeated) {
    const deliveryKey = `${item.kind}:${item.key}`;
    if (input.tracker.deliveredKeys.has(deliveryKey)) continue;
    input.tracker.deliveredKeys.add(deliveryKey);
    messages.push(subagentRepeatedExplorationSteeringMessage({
      roleId: input.session.subagentRoleId ?? "child",
      kind: item.kind,
      key: item.key,
    }));
  }
  return messages;
}

function incrementSteeringCount(map: Map<string, number>, key: string): number {
  const count = (map.get(key) ?? 0) + 1;
  map.set(key, count);
  return count;
}

function subagentRepeatedExplorationSteeringMessage(input: {
  roleId: string;
  kind: "search" | "read" | "command";
  key: string;
}): string {
  const label = input.kind === "search"
    ? "search"
    : input.kind === "read"
      ? "read"
      : "command";
  return [
    "Runtime subagent steering:",
    `${input.roleId} subagent repeated the same ${label} pattern: ${truncateForModelAside(input.key, 500)}.`,
    "If this did not produce new information, stop repeating it and move to the next useful boundary: edit the target, run validation, submit a review packet, or report the blocker/question.",
  ].join(" ");
}
