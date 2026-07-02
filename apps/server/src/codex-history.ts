import { createReadStream, promises as fs, type Stats } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { RuntimeEvent, Session } from "@openpond/contracts";

const CODEX_HISTORY_SESSION_PREFIX = "codex_history_";
const CODEX_HISTORY_EVENT_SOURCE = "codex_history";
const DEFAULT_METADATA_LIMIT = 500;
const DEFAULT_EVENT_LIMIT = 2000;
const DEFAULT_ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
const TAIL_BYTES = 512 * 1024;
const THREAD_TAIL_BYTES = 2 * 1024 * 1024;
const PROMPT_MAX_LENGTH = 30_000;
const ASSISTANT_MAX_LENGTH = 60_000;
const TOOL_OUTPUT_MAX_LENGTH = 8_000;

type CodexHistoryFile = {
  threadId: string;
  filePath: string;
  archived: boolean;
  stats: Stats;
};

type CodexHistoryIndexEntry = {
  id: string;
  threadName: string | null;
  updatedAt: string | null;
};

type CodexHistoryPromptEntry = {
  firstPrompt: string | null;
  latestPrompt: string | null;
  firstAt: string | null;
  latestAt: string | null;
};

export type CodexHistoryThread = {
  threadId: string;
  filePath: string;
  session: Session;
};

export type CodexHistoryThreadPayload = {
  session: Session;
  events: RuntimeEvent[];
};

type SessionMetadata = {
  id: string | null;
  cwd: string | null;
  createdAt: string | null;
};

type TailStatus = {
  status: Session["status"];
  latestMessageAt: string | null;
};

type CodexRecord = {
  type?: string;
  timestamp?: string;
  payload?: unknown;
};

type ParsedCodexSession = {
  events: RuntimeEvent[];
  status: Session["status"];
  updatedAt: string | null;
  firstPrompt: string | null;
};

type CodexControlMessage = {
  kind: "goal_context" | "turn_aborted";
  text: string;
};

type ParseCodexSessionInput = {
  fallbackTimestamp: string;
  maxEvents?: number;
  sessionId: string;
  threadId: string;
};

const metadataCache = new Map<string, { mtimeMs: number; size: number; metadata: SessionMetadata }>();

export function codexHistorySessionId(threadId: string): string {
  return `${CODEX_HISTORY_SESSION_PREFIX}${threadId}`;
}

export function codexHistoryThreadIdFromSessionId(sessionId: string): string | null {
  return sessionId.startsWith(CODEX_HISTORY_SESSION_PREFIX)
    ? sessionId.slice(CODEX_HISTORY_SESSION_PREFIX.length)
    : null;
}

export function isCodexHistorySessionId(sessionId: string): boolean {
  return sessionId.startsWith(CODEX_HISTORY_SESSION_PREFIX);
}

export async function loadCodexHistorySessions(options: {
  codexHome?: string;
  excludeThreadIds?: ReadonlySet<string>;
  includeThreadId?: string | null;
  metadataLimit?: number;
} = {}): Promise<Session[]> {
  const threads = await loadCodexHistoryThreads(options);
  return threads.map((thread) => thread.session);
}

export async function readCodexHistoryThreadPayload(
  sessionId: string,
  options: { codexHome?: string; maxEvents?: number; tail?: boolean; tailBytes?: number } = {},
): Promise<CodexHistoryThreadPayload> {
  const threadId = codexHistoryThreadIdFromSessionId(sessionId);
  if (!threadId) throw new Error("Codex history session not found");
  const threads = await loadCodexHistoryThreads({
    codexHome: options.codexHome,
    includeThreadId: threadId,
    metadataLimit: 1,
  });
  const thread = threads.find((candidate) => candidate.threadId === threadId);
  if (!thread) throw new Error("Codex history session not found");
  const parseInput = {
    filePath: thread.filePath,
    fallbackTimestamp: thread.session.updatedAt,
    maxEvents: options.maxEvents ?? eventLimit(),
    sessionId: thread.session.id,
    threadId: thread.threadId,
  };
  const parsed = options.tail
    ? await parseCodexSessionTailFile({
        ...parseInput,
        maxBytes: options.tailBytes ?? threadTailBytes(),
      })
    : await parseCodexSessionFile(parseInput);
  return {
    session: {
      ...thread.session,
      status: parsed.status === "active" ? "active" : thread.session.status,
      updatedAt: latestIso([parsed.updatedAt, thread.session.updatedAt]),
      title: thread.session.title === "Codex chat" && parsed.firstPrompt
        ? truncateText(normalizeTitleText(parsed.firstPrompt), 80)
        : thread.session.title,
    },
    events: parsed.events,
  };
}

export async function loadCodexHistoryThreads(options: {
  codexHome?: string;
  excludeThreadIds?: ReadonlySet<string>;
  includeThreadId?: string | null;
  metadataLimit?: number;
} = {}): Promise<CodexHistoryThread[]> {
  const codexHome = options.codexHome ?? codexHomePath();
  const [files, history, index, globalState] = await Promise.all([
    listCodexHistoryFiles(codexHome),
    readPromptHistory(codexHome),
    readSessionIndex(codexHome),
    readGlobalState(codexHome),
  ]);
  const excludeThreadIds = options.excludeThreadIds ?? new Set<string>();
  const limit = Math.max(1, options.metadataLimit ?? metadataLimit());
  const filesByThreadId = new Map(files.map((file) => [file.threadId, file]));
  const ranked = files
    .filter((file) => !excludeThreadIds.has(file.threadId) || file.threadId === options.includeThreadId)
    .map((file) => ({
      file,
      updatedMs: latestMillis([
        file.stats.mtimeMs,
        millisFromIso(history.get(file.threadId)?.latestAt),
        millisFromIso(index.get(file.threadId)?.updatedAt),
      ]),
    }))
    .sort((left, right) => right.updatedMs - left.updatedMs);

  const selected = ranked.slice(0, limit).map((item) => item.file);
  if (options.includeThreadId) {
    const explicit = filesByThreadId.get(options.includeThreadId);
    if (explicit && !selected.some((file) => file.threadId === explicit.threadId)) selected.unshift(explicit);
  }

  const threads: CodexHistoryThread[] = [];
  for (const [order, file] of selected.entries()) {
    const metadata = await readCodexSessionMetadata(file);
    const prompt = history.get(file.threadId);
    const indexEntry = index.get(file.threadId);
    const title = titleForThread(indexEntry, prompt);
    const updatedAt = latestIso([
      prompt?.latestAt,
      indexEntry?.updatedAt,
      new Date(file.stats.mtimeMs).toISOString(),
      metadata.createdAt,
    ]);
    const createdAt =
      metadata.createdAt ??
      prompt?.firstAt ??
      isoFromFileName(file.filePath) ??
      new Date(file.stats.birthtimeMs || file.stats.ctimeMs || file.stats.mtimeMs).toISOString();
    const cwd = metadata.cwd ?? globalState.workspaceRootHints.get(file.threadId) ?? null;
    const tailStatus = await statusForCodexHistoryFile(file, updatedAt);
    threads.push({
      threadId: file.threadId,
      filePath: file.filePath,
      session: {
        id: codexHistorySessionId(file.threadId),
        provider: "codex",
        title,
        appId: null,
        appName: null,
        workspaceId: null,
        workspaceName: null,
        cwd,
        codexThreadId: file.threadId,
        createdAt,
        updatedAt: latestIso([tailStatus.latestMessageAt, updatedAt]),
        status: tailStatus.status,
        pinned: false,
        archived: file.archived,
        order,
      },
    });
  }
  return threads;
}

export function parseCodexSessionRecords(
  records: CodexRecord[],
  input: ParseCodexSessionInput,
): ParsedCodexSession {
  const parser = createCodexRecordParser(input);
  for (const record of records) parser.accept(record);
  return parser.finish();
}

async function parseCodexSessionFile(input: ParseCodexSessionInput & { filePath: string }): Promise<ParsedCodexSession> {
  const parser = createCodexRecordParser(input);
  await readJsonlRecords(input.filePath, (record) => {
    parser.accept(record);
  });
  return parser.finish();
}

async function parseCodexSessionTailFile(
  input: ParseCodexSessionInput & { filePath: string; maxBytes: number },
): Promise<ParsedCodexSession> {
  const parser = createCodexRecordParser(input);
  const tail = await readTail(input.filePath, input.maxBytes);
  for (const line of tail.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const record = parseJson(line);
    if (record) parser.accept(record);
  }
  return parser.finish();
}

function createCodexRecordParser(input: ParseCodexSessionInput) {
  const maxEvents = Math.max(20, input.maxEvents ?? DEFAULT_EVENT_LIMIT);
  const events: RuntimeEvent[] = [
    historyEvent({
      id: `${input.sessionId}_session_started`,
      sessionId: input.sessionId,
      timestamp: input.fallbackTimestamp,
      name: "session.started",
      source: "server",
      data: {
        source: CODEX_HISTORY_EVENT_SOURCE,
        codexThreadId: input.threadId,
      },
    }),
  ];
  let turnIndex = 0;
  let assistantIndex = 0;
  let toolIndex = 0;
  let currentTurnId: string | null = null;
  let currentTurnStarted = false;
  let currentTurnCompleted = false;
  let firstPrompt: string | null = null;
  let goalActive = false;
  let latestUserAt: string | null = null;
  let latestLifecycleStartAt: string | null = null;
  let latestFinalAt: string | null = null;
  let latestRecordAt: string | null = null;

  function push(event: RuntimeEvent): void {
    events.push(event);
    if (events.length > maxEvents) {
      const sessionStarted = events[0];
      events.splice(1, events.length - maxEvents);
      if (sessionStarted && events[0] !== sessionStarted) events.unshift(sessionStarted);
    }
  }

  function activeTurnId(): string {
    if (currentTurnId) return currentTurnId;
    turnIndex += 1;
    currentTurnId = `${input.sessionId}_turn_${turnIndex}`;
    currentTurnStarted = false;
    currentTurnCompleted = false;
    return currentTurnId;
  }

  function beginPromptTurn(): string {
    if (!currentTurnId || currentTurnStarted || currentTurnCompleted) {
      turnIndex += 1;
      currentTurnId = `${input.sessionId}_turn_${turnIndex}`;
      currentTurnStarted = false;
    }
    currentTurnStarted = true;
    currentTurnCompleted = false;
    return currentTurnId;
  }

  function beginLifecycleTurn(): string {
    if (!currentTurnId || currentTurnCompleted) {
      turnIndex += 1;
      currentTurnId = `${input.sessionId}_turn_${turnIndex}`;
      currentTurnStarted = false;
    }
    currentTurnCompleted = false;
    return currentTurnId;
  }

  function pushThreadGoalCleared(timestamp: string, turnId: string | undefined, output = "Goal cleared"): void {
    push(
      historyEvent({
        id: `${input.sessionId}_thread_goal_cleared_${safeId(`${timestamp}_${output}`)}`,
        sessionId: input.sessionId,
        ...(turnId ? { turnId } : {}),
        timestamp,
        name: "diagnostic",
        source: "provider",
        status: "completed",
        output,
        data: {
          source: CODEX_HISTORY_EVENT_SOURCE,
          codexThreadId: input.threadId,
          kind: "thread_goal_cleared",
          provider: "codex",
          threadId: input.threadId,
        },
      }),
    );
  }

  function completeLifecycleTurn(timestamp: string, name: "turn.completed" | "turn.interrupted", output?: string): void {
    const turnId = currentTurnId ?? activeTurnId();
    if (!currentTurnCompleted) {
      push(
        historyEvent({
          id: `${turnId}_${name === "turn.completed" ? "completed" : "interrupted"}_${safeId(timestamp)}`,
          sessionId: input.sessionId,
          turnId,
          timestamp,
          name,
          source: "provider",
          status: "completed",
          ...(output ? { output } : {}),
          data: {
            source: CODEX_HISTORY_EVENT_SOURCE,
            codexThreadId: input.threadId,
          },
        }),
      );
    }
    currentTurnCompleted = true;
    latestFinalAt = timestamp;
    if (goalActive) {
      goalActive = false;
      pushThreadGoalCleared(timestamp, turnId, "Goal cleared");
    }
  }

  function accept(record: CodexRecord): void {
    const timestamp = isoTimestamp(record.timestamp) ?? input.fallbackTimestamp;
    latestRecordAt = latestIso([latestRecordAt, timestamp]);
    const payload = asRecord(record.payload);
    if (record.type === "event_msg" && payload) {
      const type = stringValue(payload.type);
      if (type === "thread_goal_updated") {
        const goal = asRecord(payload.goal);
        if (!goal) return;
        goalActive = goalRecordIsActive(goal);
        const turnId = currentTurnId ?? undefined;
        push(
          historyEvent({
            id: `${input.sessionId}_thread_goal_${safeId(timestamp)}`,
            sessionId: input.sessionId,
            ...(turnId ? { turnId } : {}),
            timestamp,
            name: "diagnostic",
            source: "provider",
            status: "completed",
            output: truncateText(goalObjective(goal) ?? "Goal runtime updated", ASSISTANT_MAX_LENGTH),
            data: {
              source: CODEX_HISTORY_EVENT_SOURCE,
              codexThreadId: input.threadId,
              kind: "thread_goal",
              provider: "codex",
              goal,
            },
          }),
        );
        return;
      }
      if (type === "thread_goal_cleared") {
        goalActive = false;
        const turnId = currentTurnId ?? undefined;
        pushThreadGoalCleared(timestamp, turnId);
        return;
      }
      if (type === "task_started") {
        beginLifecycleTurn();
        latestLifecycleStartAt = timestamp;
        return;
      }
      if (type === "task_complete") {
        completeLifecycleTurn(timestamp, "turn.completed");
        return;
      }
      if (type === "turn_aborted") {
        completeLifecycleTurn(timestamp, "turn.interrupted", turnAbortMessage(payload));
        return;
      }
    }
    if (record.type !== "response_item" || !payload) return;

    if (payload.type === "message") {
      const role = stringValue(payload.role);
      const content = textFromContent(payload.content);
      if (!content) return;
      if (role === "user") {
        const controlMessage = codexControlMessage(content);
        if (controlMessage) {
          const turnId = currentTurnId ?? undefined;
          push(
            historyEvent({
              id: `${input.sessionId}_${controlMessage.kind}_${safeId(timestamp)}`,
              sessionId: input.sessionId,
              ...(turnId ? { turnId } : {}),
              timestamp,
              name: controlMessage.kind === "turn_aborted" ? "turn.interrupted" : "diagnostic",
              source: "provider",
              status: "completed",
              output: truncateText(controlMessage.text, ASSISTANT_MAX_LENGTH),
              data: {
                source: CODEX_HISTORY_EVENT_SOURCE,
                codexThreadId: input.threadId,
                kind: controlMessage.kind,
              },
            }),
          );
          if (controlMessage.kind === "turn_aborted") {
            currentTurnCompleted = true;
            latestFinalAt = timestamp;
            if (goalActive) {
              goalActive = false;
              pushThreadGoalCleared(timestamp, turnId, "Goal cleared");
            }
          }
          return;
        }
        if (isCodexInjectedUserMessage(content)) return;
        const turnId = beginPromptTurn();
        assistantIndex = 0;
        toolIndex = 0;
        latestUserAt = timestamp;
        if (!firstPrompt) firstPrompt = content;
        push(
          historyEvent({
            id: `${turnId}_started`,
            sessionId: input.sessionId,
            turnId,
            timestamp,
            name: "turn.started",
            source: "chat_action",
            args: { prompt: truncateText(content, PROMPT_MAX_LENGTH) },
            status: "started",
            data: {
              source: CODEX_HISTORY_EVENT_SOURCE,
              codexThreadId: input.threadId,
            },
          }),
        );
        return;
      }

      if (role === "assistant") {
        assistantIndex += 1;
        const turnId = activeTurnId();
        const phase = stringValue(payload.phase);
        push(
          historyEvent({
            id: `${turnId}_assistant_${assistantIndex}`,
            sessionId: input.sessionId,
            turnId,
            timestamp,
            name: "assistant.delta",
            source: "provider",
            output: truncateText(content, ASSISTANT_MAX_LENGTH),
            data: {
              source: CODEX_HISTORY_EVENT_SOURCE,
              codexThreadId: input.threadId,
              ...(phase ? { phase } : {}),
            },
          }),
        );
        if (phase === "final_answer") {
          latestFinalAt = timestamp;
          if (!currentTurnCompleted) {
            push(
              historyEvent({
                id: `${turnId}_completed`,
                sessionId: input.sessionId,
                turnId,
                timestamp,
                name: "turn.completed",
                source: "provider",
                status: "completed",
                data: {
                  source: CODEX_HISTORY_EVENT_SOURCE,
                  codexThreadId: input.threadId,
                },
              }),
            );
          }
          currentTurnCompleted = true;
        }
      }
      return;
    }

    if (payload.type === "function_call") {
      toolIndex += 1;
      const turnId = activeTurnId();
      const callId = safeId(stringValue(payload.call_id) ?? String(toolIndex));
      const name = stringValue(payload.name) ?? "tool";
      const parsedArgs = parseMaybeJson(stringValue(payload.arguments) ?? "");
      const command = commandFromToolCall(name, parsedArgs);
      push(
        historyEvent({
          id: `${turnId}_tool_started_${toolIndex}_${callId}`,
          sessionId: input.sessionId,
          turnId,
          timestamp,
          name: "tool.started",
          source: "provider",
          action: name,
          status: "started",
          output: command,
          data: {
            source: CODEX_HISTORY_EVENT_SOURCE,
            codexThreadId: input.threadId,
            callId,
            tool: name,
            arguments: parsedArgs ?? stringValue(payload.arguments) ?? "",
            command,
          },
        }),
      );
      return;
    }

    if (payload.type === "function_call_output") {
      toolIndex += 1;
      const turnId = activeTurnId();
      const callId = safeId(stringValue(payload.call_id) ?? String(toolIndex));
      const output = truncateText(stringValue(payload.output) ?? "", TOOL_OUTPUT_MAX_LENGTH);
      push(
        historyEvent({
          id: `${turnId}_tool_completed_${toolIndex}_${callId}`,
          sessionId: input.sessionId,
          turnId,
          timestamp,
          name: "tool.completed",
          source: "provider",
          action: "function_call_output",
          status: "completed",
          output,
          data: {
            source: CODEX_HISTORY_EVENT_SOURCE,
            codexThreadId: input.threadId,
            callId,
          },
        }),
      );
      if (output) {
        push(
          historyEvent({
            id: `${turnId}_command_output_${toolIndex}_${callId}`,
            sessionId: input.sessionId,
            turnId,
            timestamp,
            name: "command.output",
            source: "provider",
            output,
            data: {
              source: CODEX_HISTORY_EVENT_SOURCE,
              codexThreadId: input.threadId,
              callId,
            },
          }),
        );
      }
    }
  }

  function finish(): ParsedCodexSession {
    const latestUserMs = Math.max(millisFromIso(latestUserAt), millisFromIso(latestLifecycleStartAt));
    const latestFinalMs = millisFromIso(latestFinalAt);
    const turnActive = Boolean(latestUserMs && (!latestFinalMs || latestUserMs > latestFinalMs) && !currentTurnCompleted);
    const status = goalActive || turnActive ? "active" : "idle";
    return {
      events,
      status,
      updatedAt: latestRecordAt,
      firstPrompt,
    };
  }

  return { accept, finish };
}

async function listCodexHistoryFiles(codexHome: string): Promise<CodexHistoryFile[]> {
  const roots = [
    { root: path.join(codexHome, "sessions"), archived: false },
    { root: path.join(codexHome, "archived_sessions"), archived: true },
  ];
  const files: CodexHistoryFile[] = [];
  for (const { root, archived } of roots) {
    await walkCodexHistoryFiles(root, archived, files);
  }
  return files;
}

async function walkCodexHistoryFiles(root: string, archived: boolean, output: CodexHistoryFile[]): Promise<void> {
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        await walkCodexHistoryFiles(entryPath, archived, output);
        return;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) return;
      const threadId = threadIdFromFileName(entry.name);
      if (!threadId) return;
      const stats = await fs.stat(entryPath).catch(() => null);
      if (!stats) return;
      output.push({ threadId, filePath: entryPath, archived, stats });
    }),
  );
}

async function readPromptHistory(codexHome: string): Promise<Map<string, CodexHistoryPromptEntry>> {
  const entries = new Map<string, CodexHistoryPromptEntry>();
  await readJsonlRecords(path.join(codexHome, "history.jsonl"), (record) => {
    const payload = asRecord(record);
    const threadId = stringValue(payload?.session_id);
    const text = normalizeTitleText(stringValue(payload?.text) ?? "");
    const timestamp = isoFromEpochSeconds(numberValue(payload?.ts));
    if (!threadId || !text || !timestamp) return;
    const current = entries.get(threadId) ?? {
      firstPrompt: null,
      latestPrompt: null,
      firstAt: null,
      latestAt: null,
    };
    if (!current.firstAt || millisFromIso(timestamp) < millisFromIso(current.firstAt)) {
      current.firstAt = timestamp;
      current.firstPrompt = text;
    }
    if (!current.latestAt || millisFromIso(timestamp) > millisFromIso(current.latestAt)) {
      current.latestAt = timestamp;
      current.latestPrompt = text;
    }
    entries.set(threadId, current);
  }).catch(() => undefined);
  return entries;
}

async function readSessionIndex(codexHome: string): Promise<Map<string, CodexHistoryIndexEntry>> {
  const entries = new Map<string, CodexHistoryIndexEntry>();
  await readJsonlRecords(path.join(codexHome, "session_index.jsonl"), (record) => {
    const payload = asRecord(record);
    const id = stringValue(payload?.id);
    if (!id) return;
    entries.set(id, {
      id,
      threadName: normalizeTitleText(stringValue(payload?.thread_name) ?? "") || null,
      updatedAt: isoTimestamp(stringValue(payload?.updated_at)),
    });
  }).catch(() => undefined);
  return entries;
}

async function readGlobalState(codexHome: string): Promise<{
  workspaceRootHints: Map<string, string>;
}> {
  const filePath = path.join(codexHome, ".codex-global-state.json");
  let payload: unknown;
  try {
    payload = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    payload = null;
  }
  const state = asRecord(payload);
  return {
    workspaceRootHints: stringMap(asRecord(state?.["thread-workspace-root-hints"])),
  };
}

async function readCodexSessionMetadata(file: CodexHistoryFile): Promise<SessionMetadata> {
  const cached = metadataCache.get(file.filePath);
  if (cached && cached.mtimeMs === file.stats.mtimeMs && cached.size === file.stats.size) return cached.metadata;
  let metadata: SessionMetadata = { id: null, cwd: null, createdAt: null };
  await readInitialJsonlRecords(file.filePath, 80, (record) => {
    const payload = asRecord(record.payload);
    if (!payload) return;
    if (record.type === "session_meta") {
      metadata = {
        id: metadata.id ?? stringValue(payload.id) ?? stringValue(payload.session_id),
        cwd: metadata.cwd ?? stringValue(payload.cwd),
        createdAt: metadata.createdAt ?? isoTimestamp(stringValue(payload.timestamp) ?? stringValue(record.timestamp)),
      };
    }
    if (record.type === "turn_context" && !metadata.cwd) {
      metadata = {
        ...metadata,
        cwd: stringValue(payload.cwd),
      };
    }
  });
  metadataCache.set(file.filePath, {
    mtimeMs: file.stats.mtimeMs,
    size: file.stats.size,
    metadata,
  });
  return metadata;
}

async function statusForCodexHistoryFile(file: CodexHistoryFile, fallbackUpdatedAt: string): Promise<TailStatus> {
  const recent = Date.now() - file.stats.mtimeMs <= DEFAULT_ACTIVE_WINDOW_MS;
  if (!recent) return { status: "idle", latestMessageAt: null };
  const tail = await readTail(file.filePath, TAIL_BYTES).catch(() => "");
  if (!tail) return { status: "idle", latestMessageAt: null };
  let latestUserAt: string | null = null;
  let latestFinalAt: string | null = null;
  let latestAssistantAt: string | null = null;
  let latestGoalAt: string | null = null;
  let latestLifecycleStartAt: string | null = null;
  let latestLifecycleAt: string | null = null;
  let goalActive = false;
  let hasRunningMarker = false;
  for (const line of tail.split(/\r?\n/)) {
    const record = parseJson(line);
    if (!record) continue;
    const timestamp = isoTimestamp(record.timestamp) ?? fallbackUpdatedAt;
    const payload = asRecord(record.payload);
    if (record.type === "event_msg" && payload) {
      const type = stringValue(payload.type);
      if (type === "thread_goal_updated") {
        const goal = asRecord(payload.goal);
        if (goal) {
          latestGoalAt = timestamp;
          goalActive = goalRecordIsActive(goal);
        }
      } else if (type === "thread_goal_cleared") {
        latestGoalAt = timestamp;
        goalActive = false;
      } else if (type === "task_started") {
        latestLifecycleStartAt = timestamp;
        latestLifecycleAt = timestamp;
      } else if (type === "task_complete" || type === "turn_aborted") {
        latestFinalAt = timestamp;
        latestLifecycleAt = timestamp;
        if (goalActive) {
          latestGoalAt = timestamp;
          goalActive = false;
        }
      }
      continue;
    }
    if (record.type !== "response_item" || !payload) continue;
    if (payload.type === "message") {
      const role = stringValue(payload.role);
      const content = textFromContent(payload.content);
      if (role === "user" && content) {
        const controlMessage = codexControlMessage(content);
        if (controlMessage?.kind === "turn_aborted") latestFinalAt = timestamp;
        if (!controlMessage && !isCodexInjectedUserMessage(content)) latestUserAt = timestamp;
      }
      if (role === "assistant" && content) {
        latestAssistantAt = timestamp;
        if (stringValue(payload.phase) === "final_answer") latestFinalAt = timestamp;
      }
    }
    if (payload.type === "function_call_output" && /Process running with session ID/i.test(stringValue(payload.output) ?? "")) {
      hasRunningMarker = true;
    }
  }
  const latestUserMs = Math.max(millisFromIso(latestUserAt), millisFromIso(latestLifecycleStartAt));
  const latestFinalMs = millisFromIso(latestFinalAt);
  const active = Boolean(latestUserMs && (!latestFinalMs || latestUserMs > latestFinalMs));
  return {
    status: goalActive || active || (hasRunningMarker && !latestFinalMs) ? "active" : "idle",
    latestMessageAt: latestIso([latestAssistantAt, latestUserAt, latestGoalAt, latestLifecycleAt]),
  };
}

async function readJsonlRecords(filePath: string, onRecord: (record: CodexRecord) => void): Promise<void> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of reader) {
    if (!line.trim()) continue;
    const record = parseJson(line);
    if (record) onRecord(record);
  }
}

async function readInitialJsonlRecords(
  filePath: string,
  maxRecords: number,
  onRecord: (record: CodexRecord) => void,
): Promise<void> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  let count = 0;
  try {
    for await (const line of reader) {
      if (!line.trim()) continue;
      const record = parseJson(line);
      if (record) {
        onRecord(record);
        count += 1;
      }
      if (count >= maxRecords) return;
    }
  } finally {
    reader.close();
    stream.destroy();
  }
}

async function readTail(filePath: string, maxBytes: number): Promise<string> {
  const handle = await fs.open(filePath, "r");
  try {
    const stats = await handle.stat();
    const length = Math.min(maxBytes, stats.size);
    const offset = Math.max(0, stats.size - length);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    const value = buffer.subarray(0, bytesRead).toString("utf8");
    if (offset === 0) return value;
    const firstNewline = value.search(/\r?\n/);
    return firstNewline === -1 ? value : value.slice(firstNewline + 1);
  } finally {
    await handle.close();
  }
}

function historyEvent(input: RuntimeEvent): RuntimeEvent {
  return input;
}

function titleForThread(indexEntry: CodexHistoryIndexEntry | undefined, prompt: CodexHistoryPromptEntry | undefined): string {
  return truncateText(indexEntry?.threadName ?? prompt?.firstPrompt ?? prompt?.latestPrompt ?? "Codex chat", 80);
}

function commandFromToolCall(name: string, args: unknown): string {
  const record = asRecord(args);
  return stringValue(record?.cmd) ?? stringValue(record?.command) ?? stringValue(record?.tool) ?? name;
}

function goalObjective(goal: Record<string, unknown>): string | null {
  return stringValue(goal.objective);
}

function goalRecordIsActive(goal: Record<string, unknown>): boolean {
  const status = stringValue(goal.status) ?? "active";
  const normalized = status.toLowerCase();
  return !(
    normalized.includes("complete") ||
    normalized.includes("achieved") ||
    normalized.includes("blocked") ||
    normalized.includes("limited") ||
    normalized.includes("paused") ||
    normalized.includes("stopped") ||
    normalized.includes("canceled") ||
    normalized.includes("cancelled") ||
    normalized.includes("interrupted") ||
    normalized.includes("aborted") ||
    normalized.includes("failed") ||
    normalized.includes("closed")
  );
}

function turnAbortMessage(payload: Record<string, unknown>): string {
  const reason = stringValue(payload.reason);
  return reason ? `Turn interrupted: ${reason}` : "Turn interrupted.";
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (typeof item === "string") return item;
      const record = asRecord(item);
      return stringValue(record?.text) ?? "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function isCodexInjectedUserMessage(content: string): boolean {
  const trimmed = content.trim();
  return (
    trimmed.startsWith("# AGENTS.md instructions for ") ||
    trimmed.startsWith("<environment_context>") ||
    trimmed.startsWith("<summary>") ||
    trimmed.startsWith("<user_info>")
  );
}

function codexControlMessage(content: string): CodexControlMessage | null {
  const trimmed = content.trim();
  const match = /^<(goal_context|turn_aborted)>\s*([\s\S]*?)\s*<\/\1>$/.exec(trimmed);
  if (match) {
    const kind = match[1] as CodexControlMessage["kind"];
    return {
      kind,
      text: match[2]?.trim() || defaultCodexControlText(kind),
    };
  }
  if (trimmed === "<turn_aborted>") return { kind: "turn_aborted", text: defaultCodexControlText("turn_aborted") };
  if (trimmed === "<goal_context>") return { kind: "goal_context", text: defaultCodexControlText("goal_context") };
  return null;
}

function defaultCodexControlText(kind: CodexControlMessage["kind"]): string {
  return kind === "turn_aborted" ? "The previous turn was interrupted." : "Goal context updated.";
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n\n[truncated ${value.length - maxLength} characters from Codex history]`;
}

function normalizeTitleText(value: string): string {
  return value.replace(/[^\S\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function parseMaybeJson(value: string): unknown | null {
  if (!value.trim()) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function parseJson(value: string): CodexRecord | null {
  if (!value.trim()) return null;
  try {
    return JSON.parse(value) as CodexRecord;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringMap(record: Record<string, unknown> | null): Map<string, string> {
  const map = new Map<string, string>();
  if (!record) return map;
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && value.trim()) map.set(key, value.trim());
  }
  return map;
}

function threadIdFromFileName(fileName: string): string | null {
  return /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(fileName)?.[1] ?? null;
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 96) || "item";
}

function latestMillis(values: Array<number | null | undefined>): number {
  let latest = 0;
  for (const value of values) {
    if (typeof value === "number" && value > latest) latest = value;
  }
  return latest;
}

function latestIso(values: Array<string | null | undefined>): string {
  const latest = latestMillis(values.map(millisFromIso));
  return new Date(latest || Date.now()).toISOString();
}

function millisFromIso(value: string | null | undefined): number {
  if (!value) return 0;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : 0;
}

function isoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  const normalized = trimmed.replace(/(\.\d{3})\d+(Z)$/i, "$1$2");
  const millis = Date.parse(normalized);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

function isoFromEpochSeconds(value: number | null): string | null {
  if (value === null) return null;
  const millis = value * 1000;
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

function isoFromFileName(filePath: string): string | null {
  const match = /rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-/.exec(path.basename(filePath));
  if (!match) return null;
  return isoTimestamp(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.000Z`);
}

function codexHomePath(): string {
  return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
}

function metadataLimit(): number {
  return positiveIntegerEnv("OPENPOND_CODEX_HISTORY_LIMIT", DEFAULT_METADATA_LIMIT);
}

function eventLimit(): number {
  return positiveIntegerEnv("OPENPOND_CODEX_HISTORY_EVENT_LIMIT", DEFAULT_EVENT_LIMIT);
}

function threadTailBytes(): number {
  return positiveIntegerEnv("OPENPOND_CODEX_HISTORY_THREAD_TAIL_BYTES", THREAD_TAIL_BYTES);
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
