import {
  createReadStream,
  existsSync,
  mkdirSync,
  promises as fs,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { DEFAULT_OPENPOND_COMMAND_ACCESS_MODE } from "@openpond/contracts";
import type { ChatAttachmentSummary, RuntimeEvent, Session } from "@openpond/contracts";
import {
  chatAttachmentImageContentType,
  safeChatAttachmentPathSegment,
} from "./chat-attachments.js";
import {
  loadCodexHistoryFileIndex,
  type CodexHistoryFile,
} from "./codex-history-file-index.js";

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
const MAX_CODEX_HISTORY_IMAGE_BYTES = 15 * 1024 * 1024;

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
  goalRuntime: CodexHistoryGoalRuntimeMetadata | null;
};

type CodexHistoryGoalRuntimeMetadata = {
  provider: "codex";
  objective: string;
  status: string;
  timeUsedSeconds: number;
  tokensUsed: number | null;
  tokenBudget: number | null;
  updatedAt: string;
};

type CodexRecord = {
  arguments?: string;
  call_id?: string;
  content?: unknown;
  name?: string;
  output?: string;
  type?: string;
  role?: string;
  phase?: string;
  record_type?: string;
  timestamp?: string;
  payload?: unknown;
};

type ParsedCodexSession = {
  events: RuntimeEvent[];
  status: Session["status"];
  updatedAt: string | null;
  firstPrompt: string | null;
  goalRuntime: CodexHistoryGoalRuntimeMetadata | null;
};

type CodexControlMessage = {
  kind: "goal_context" | "turn_aborted";
  text: string;
};

type ParseCodexSessionInput = {
  attachmentRootDir?: string;
  fallbackTimestamp: string;
  maxEvents?: number;
  sessionId: string;
  threadId: string;
};

const metadataCache = new Map<string, { mtimeMs: number; size: number; metadata: SessionMetadata }>();
const threadLookupCache = new Map<string, CodexHistoryThread>();

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

export async function loadCodexHistorySearchFiles(codexHome = codexHomePath()): Promise<CodexHistoryFile[]> {
  return loadCodexHistoryFileIndex(codexHome);
}

export async function readCodexHistoryThreadPayload(
  sessionId: string,
  options: {
    attachmentRootDir?: string;
    codexHome?: string;
    maxEvents?: number;
    tail?: boolean;
    tailBytes?: number;
  } = {},
): Promise<CodexHistoryThreadPayload> {
  const threadId = codexHistoryThreadIdFromSessionId(sessionId);
  if (!threadId) throw new Error("Codex history session not found");
  const codexHome = options.codexHome ?? codexHomePath();
  const cacheKey = threadLookupCacheKey(codexHome, threadId);
  let thread = threadLookupCache.get(cacheKey);
  if (!thread || !existsSync(thread.filePath)) {
    const threads = await loadCodexHistoryThreads({
      codexHome,
      includeThreadId: threadId,
      metadataLimit: 1,
    });
    thread = threads.find((candidate) => candidate.threadId === threadId);
  }
  if (!thread) throw new Error("Codex history session not found");
  const parseInput = {
    attachmentRootDir: options.attachmentRootDir,
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
      metadata: sessionMetadataWithCodexGoalRuntime(
        thread.session.metadata,
        parsed.goalRuntime ?? codexGoalRuntimeFromSessionMetadata(thread.session.metadata),
      ),
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
    loadCodexHistoryFileIndex(codexHome),
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
        openPondCommandAccessMode: DEFAULT_OPENPOND_COMMAND_ACCESS_MODE,
        title,
        appId: null,
        appName: null,
        workspaceId: null,
        workspaceName: null,
        metadata: sessionMetadataWithCodexGoalRuntime(undefined, tailStatus.goalRuntime),
        cwd,
        codexThreadId: file.threadId,
        createdAt,
        updatedAt: latestIso([tailStatus.latestMessageAt, updatedAt]),
        status: tailStatus.status,
        pinned: false,
        savedForLater: false,
        archived: file.archived,
        order,
      },
    });
  }
  for (const thread of threads) {
    threadLookupCache.set(
      threadLookupCacheKey(codexHome, thread.threadId),
      thread,
    );
  }
  return threads;
}

function threadLookupCacheKey(codexHome: string, threadId: string): string {
  return `${path.resolve(codexHome)}\0${threadId}`;
}

export function parseCodexSessionRecords(
  records: CodexRecord[],
  input: ParseCodexSessionInput,
): ParsedCodexSession {
  const parser = createCodexRecordParser(input);
  for (const record of records) parser.accept(record);
  return parser.finish();
}

export async function readCodexHistorySearchText(thread: Pick<CodexHistoryThread, "filePath">): Promise<string> {
  const messages: string[] = [];
  await readJsonlRecords(thread.filePath, (record) => {
    const payload = asRecord(record.payload);
    const responsePayload = responsePayloadFromCodexRecord(record, payload);
    if (responsePayload?.type !== "message") return;
    const role = stringValue(responsePayload.role);
    if (role !== "user" && role !== "assistant") return;
    const text = textFromContent(responsePayload.content).trim();
    if (!text || (role === "user" && codexControlMessage(text))) return;
    messages.push(text);
  });
  return messages.join("\n");
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
  let latestKnownGoalRuntime: CodexHistoryGoalRuntimeMetadata | null = null;
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

  function pushThreadGoalCleared(
    timestamp: string,
    turnId: string | undefined,
    output = "Goal cleared",
    synthetic = false,
  ): void {
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
          synthetic,
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
      pushThreadGoalCleared(timestamp, turnId, "Goal cleared", true);
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
        latestKnownGoalRuntime = activeGoalRuntimeFromCodexGoalRecord(goal, timestamp);
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
        latestKnownGoalRuntime = null;
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
    const responsePayload = responsePayloadFromCodexRecord(record, payload);
    if (!responsePayload) return;

    if (responsePayload.type === "message") {
      const role = stringValue(responsePayload.role);
      const rawContent = responsePayload.content;
      const content = textFromContent(rawContent);
      if (!content && !codexContentHasInputImage(rawContent)) return;
      if (role === "user") {
        const internalGoalRuntime = activeGoalRuntimeFromCodexInternalContext(content, timestamp);
        if (internalGoalRuntime) {
          goalActive = true;
          latestKnownGoalRuntime ??= internalGoalRuntime;
        }
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
              pushThreadGoalCleared(timestamp, turnId, "Goal cleared", true);
            }
          }
          return;
        }
        if (isCodexInjectedUserMessage(content)) return;
        const turnId = beginPromptTurn();
        const userContent = visibleCodexUserContent(rawContent, {
          attachmentRootDir: input.attachmentRootDir,
          sessionId: input.sessionId,
          turnId,
        });
        assistantIndex = 0;
        toolIndex = 0;
        latestUserAt = timestamp;
        if (!firstPrompt) firstPrompt = userContent.prompt;
        push(
          historyEvent({
            id: `${turnId}_started`,
            sessionId: input.sessionId,
            turnId,
            timestamp,
            name: "turn.started",
            source: "chat_action",
            args: {
              prompt: truncateText(userContent.prompt, PROMPT_MAX_LENGTH),
              ...(userContent.attachments.length > 0 ? { attachments: userContent.attachments } : {}),
            },
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
        const phase = stringValue(responsePayload.phase);
        const legacyFinalAnswer = record.type === "message";
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
        if (phase === "final_answer" || legacyFinalAnswer) {
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

    if (responsePayload.type === "function_call") {
      toolIndex += 1;
      const turnId = activeTurnId();
      const callId = safeId(stringValue(responsePayload.call_id) ?? String(toolIndex));
      const name = stringValue(responsePayload.name) ?? "tool";
      const parsedArgs = parseMaybeJson(stringValue(responsePayload.arguments) ?? "");
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
            arguments: parsedArgs ?? stringValue(responsePayload.arguments) ?? "",
            command,
          },
        }),
      );
      return;
    }

    if (responsePayload.type === "function_call_output") {
      toolIndex += 1;
      const turnId = activeTurnId();
      const callId = safeId(stringValue(responsePayload.call_id) ?? String(toolIndex));
      const output = truncateText(stringValue(responsePayload.output) ?? "", TOOL_OUTPUT_MAX_LENGTH);
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
      goalRuntime: latestKnownGoalRuntime,
    };
  }

  return { accept, finish };
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
  if (!recent) return { status: "idle", latestMessageAt: null, goalRuntime: null };
  const tail = await readTail(file.filePath, TAIL_BYTES).catch(() => "");
  if (!tail) return { status: "idle", latestMessageAt: null, goalRuntime: null };
  let latestUserAt: string | null = null;
  let latestFinalAt: string | null = null;
  let latestAssistantAt: string | null = null;
  let latestGoalAt: string | null = null;
  let latestLifecycleStartAt: string | null = null;
  let latestLifecycleAt: string | null = null;
  let goalActive = false;
  let latestKnownGoalRuntime: CodexHistoryGoalRuntimeMetadata | null = null;
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
          latestKnownGoalRuntime = activeGoalRuntimeFromCodexGoalRecord(goal, timestamp);
        }
      } else if (type === "thread_goal_cleared") {
        latestGoalAt = timestamp;
        goalActive = false;
        latestKnownGoalRuntime = null;
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
    const responsePayload = responsePayloadFromCodexRecord(record, payload);
    if (!responsePayload) continue;
    if (responsePayload.type === "message") {
      const role = stringValue(responsePayload.role);
      const content = textFromContent(responsePayload.content);
      if (role === "user" && content) {
        const internalGoalRuntime = activeGoalRuntimeFromCodexInternalContext(content, timestamp);
        if (internalGoalRuntime) {
          latestKnownGoalRuntime ??= internalGoalRuntime;
          latestGoalAt = timestamp;
          goalActive = true;
        }
        const controlMessage = codexControlMessage(content);
        if (controlMessage?.kind === "turn_aborted") latestFinalAt = timestamp;
        if (!controlMessage && !isCodexInjectedUserMessage(content)) latestUserAt = timestamp;
      }
      if (role === "assistant" && content) {
        latestAssistantAt = timestamp;
        if (stringValue(responsePayload.phase) === "final_answer" || record.type === "message") {
          latestFinalAt = timestamp;
        }
      }
    }
    if (
      responsePayload.type === "function_call_output" &&
      /Process running with session ID/i.test(stringValue(responsePayload.output) ?? "")
    ) {
      hasRunningMarker = true;
    }
  }
  const latestUserMs = Math.max(millisFromIso(latestUserAt), millisFromIso(latestLifecycleStartAt));
  const latestFinalMs = millisFromIso(latestFinalAt);
  const active = Boolean(latestUserMs && (!latestFinalMs || latestUserMs > latestFinalMs));
  const status = goalActive || active || (hasRunningMarker && !latestFinalMs) ? "active" : "idle";
  if (status === "active" && !latestKnownGoalRuntime) {
    latestKnownGoalRuntime = await latestKnownActiveGoalRuntimeForCodexHistoryFile(file, fallbackUpdatedAt);
  }
  return {
    status,
    latestMessageAt: latestIso([latestAssistantAt, latestUserAt, latestGoalAt, latestLifecycleAt]),
    goalRuntime: latestKnownGoalRuntime,
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

function responsePayloadFromCodexRecord(
  record: CodexRecord,
  payload: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (record.type === "response_item") return payload;
  if (!isLegacyResponseItemType(record.type)) return null;
  return asRecord(record);
}

function isLegacyResponseItemType(type: string | undefined): boolean {
  return (
    type === "message" ||
    type === "function_call" ||
    type === "function_call_output" ||
    type === "custom_tool_call" ||
    type === "custom_tool_call_output"
  );
}

function goalObjective(goal: Record<string, unknown>): string | null {
  return stringValue(goal.objective);
}

function activeGoalRuntimeFromCodexGoalRecord(
  goal: Record<string, unknown>,
  timestamp: string,
): CodexHistoryGoalRuntimeMetadata | null {
  if (!goalRecordIsActive(goal)) return null;
  return {
    provider: "codex",
    objective: goalObjective(goal) ?? "Active goal",
    status: stringValue(goal.status) ?? "active",
    timeUsedSeconds: nonNegativeInteger(
      numberValue(goal.timeUsedSeconds) ?? numberValue(goal.time_used_seconds) ?? 0,
    ),
    tokensUsed: nullableNonNegativeInteger(numberValue(goal.tokensUsed) ?? numberValue(goal.tokens_used)),
    tokenBudget: nullableNonNegativeInteger(numberValue(goal.tokenBudget) ?? numberValue(goal.token_budget)),
    updatedAt: timestamp,
  };
}

function activeGoalRuntimeFromCodexInternalContext(
  content: string,
  timestamp: string,
): CodexHistoryGoalRuntimeMetadata | null {
  if (!/<codex_internal_context\b[^>]*\bsource=["']goal["'][^>]*>/i.test(content)) return null;
  return {
    provider: "codex",
    objective: xmlBlock(content, "objective") ?? "Active goal",
    status: "active",
    timeUsedSeconds: nonNegativeInteger(numberFromLine(content, "Time used seconds") ?? 0),
    tokensUsed: nullableNonNegativeInteger(numberFromLine(content, "Tokens used")),
    tokenBudget: nullableNonNegativeInteger(numberFromLine(content, "Token budget")),
    updatedAt: timestamp,
  };
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

async function latestKnownActiveGoalRuntimeForCodexHistoryFile(
  file: CodexHistoryFile,
  fallbackUpdatedAt: string,
): Promise<CodexHistoryGoalRuntimeMetadata | null> {
  let latestKnownGoalRuntime: CodexHistoryGoalRuntimeMetadata | null = null;
  await readJsonlRecords(file.filePath, (record) => {
    const timestamp = isoTimestamp(record.timestamp) ?? fallbackUpdatedAt;
    const payload = asRecord(record.payload);
    if (record.type === "event_msg" && payload) {
      const type = stringValue(payload.type);
      if (type === "thread_goal_updated") {
        const goal = asRecord(payload.goal);
        if (goal) latestKnownGoalRuntime = activeGoalRuntimeFromCodexGoalRecord(goal, timestamp);
        return;
      }
      if (type === "thread_goal_cleared") {
        latestKnownGoalRuntime = null;
        return;
      }
    }
    const responsePayload = responsePayloadFromCodexRecord(record, payload);
    if (responsePayload?.type !== "message" || stringValue(responsePayload.role) !== "user") return;
    const internalGoalRuntime = activeGoalRuntimeFromCodexInternalContext(
      textFromContent(responsePayload.content),
      timestamp,
    );
    if (internalGoalRuntime && !latestKnownGoalRuntime) latestKnownGoalRuntime = internalGoalRuntime;
  }).catch(() => undefined);
  return latestKnownGoalRuntime;
}

function sessionMetadataWithCodexGoalRuntime(
  metadata: Session["metadata"] | undefined,
  goalRuntime: CodexHistoryGoalRuntimeMetadata | null,
): Session["metadata"] | undefined {
  const next = { ...(metadata ?? {}) };
  delete next.codexGoalRuntime;
  if (goalRuntime) next.codexGoalRuntime = goalRuntime;
  return Object.keys(next).length > 0 ? next : undefined;
}

function codexGoalRuntimeFromSessionMetadata(
  metadata: Session["metadata"] | undefined,
): CodexHistoryGoalRuntimeMetadata | null {
  const record = asRecord(metadata?.codexGoalRuntime);
  if (!record || stringValue(record.provider) !== "codex") return null;
  const objective = stringValue(record.objective);
  const status = stringValue(record.status);
  const updatedAt = isoTimestamp(record.updatedAt);
  if (!objective || !status || !updatedAt) return null;
  return {
    provider: "codex",
    objective,
    status,
    timeUsedSeconds: nonNegativeInteger(numberValue(record.timeUsedSeconds) ?? 0),
    tokensUsed: nullableNonNegativeInteger(numberValue(record.tokensUsed)),
    tokenBudget: nullableNonNegativeInteger(numberValue(record.tokenBudget)),
    updatedAt,
  };
}

function turnAbortMessage(payload: Record<string, unknown>): string {
  const reason = stringValue(payload.reason);
  return reason ? `Turn interrupted: ${reason}` : "Turn interrupted.";
}

function xmlBlock(value: string, tagName: string): string | null {
  const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`<${escapedTag}[^>]*>([\\s\\S]*?)<\\/${escapedTag}>`, "i").exec(value);
  return match?.[1]?.trim() || null;
}

function lineValue(value: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^\\s*-?\\s*${escaped}:\\s*(.+?)\\s*$`, "im").exec(value);
  return match?.[1]?.trim() || null;
}

function numberFromLine(value: string, label: string): number | null {
  const raw = lineValue(value, label);
  if (!raw || raw.toLowerCase() === "none") return null;
  const normalized = raw.replace(/,/g, "");
  const match = /^-?\d+(?:\.\d+)?/.exec(normalized);
  if (!match) return null;
  const number = Number(match[0]);
  return Number.isFinite(number) ? number : null;
}

function nonNegativeInteger(value: number): number {
  return Math.max(0, Math.floor(value));
}

function nullableNonNegativeInteger(value: number | null): number | null {
  return value === null ? null : nonNegativeInteger(value);
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

type VisibleCodexUserContent = {
  prompt: string;
  attachments: ChatAttachmentSummary[];
};

type VisibleCodexUserContentContext = {
  attachmentRootDir?: string;
  sessionId: string;
  turnId: string;
};

type CodexUserContentParts = {
  text: string;
  inputImages: string[];
};

type CodexImageReference = {
  label: string | null;
  localPath: string | null;
};

const CODEX_ATTACHMENT_CONTEXT_PATTERN = /(?:^|\n)\s*<attachments>\s*([\s\S]*?)\s*<\/attachments>\s*/g;
const CODEX_ATTACHMENT_LINE_PATTERN =
  /^\s*\d+\.\s+(.+)\s+\(([^,]+),\s*([0-9]+(?:\.[0-9]+)?)\s*(B|KB|MB|GB|TB),\s*(image|text|file)\)\.(?:\s+Saved locally at:\s*(.+))?\s*$/i;
const CODEX_IMAGE_TAG_PATTERN =
  /<image\s+name=(?:\[([^\]]*)\]|"([^"]*)"|'([^']*)'|([^\s>]+))\s+path="([^"]+)"\s*>/g;
const DATA_IMAGE_URL_PATTERN = /^data:([^;,]+);base64,([a-zA-Z0-9+/=\s]+)$/;

function visibleCodexUserContent(content: unknown, context: VisibleCodexUserContentContext): VisibleCodexUserContent {
  const parts = codexUserContentParts(content);
  const attachments: ChatAttachmentSummary[] = [];
  let blockIndex = 0;
  const imageReferences = codexImageReferences(parts.text);
  const prompt = parts.text
    .replace(CODEX_ATTACHMENT_CONTEXT_PATTERN, (_match, body: string) => {
      attachments.push(...parseCodexAttachmentContext(body, context, blockIndex));
      blockIndex += 1;
      return "\n";
    })
    .replace(CODEX_IMAGE_TAG_PATTERN, "\n")
    .trim();

  attachments.push(...codexInputImageAttachments(parts.inputImages, imageReferences, context, attachments.length));
  if (parts.inputImages.length === 0) {
    attachments.push(...codexImageReferenceAttachments(imageReferences, context, attachments.length));
  }

  return {
    prompt: prompt || (attachments.length > 0 ? "Please review the attached files." : parts.text.trim()),
    attachments,
  };
}

function codexUserContentParts(content: unknown): CodexUserContentParts {
  if (typeof content === "string") return { text: content.trim(), inputImages: [] };
  if (!Array.isArray(content)) return { text: "", inputImages: [] };
  const text: string[] = [];
  const inputImages: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      text.push(item);
      continue;
    }
    const record = asRecord(item);
    const itemText = stringValue(record?.text);
    if (itemText) text.push(itemText);
    const imageUrl = stringValue(record?.image_url);
    if (imageUrl && stringValue(record?.type) === "input_image") inputImages.push(imageUrl);
  }
  return {
    text: text.filter(Boolean).join("\n").trim(),
    inputImages,
  };
}

function codexContentHasInputImage(content: unknown): boolean {
  return codexUserContentParts(content).inputImages.length > 0;
}

function codexImageReferences(text: string): CodexImageReference[] {
  return Array.from(text.matchAll(CODEX_IMAGE_TAG_PATTERN)).map((match) => ({
    label: match[1] ?? match[2] ?? match[3] ?? match[4] ?? null,
    localPath: match[5] ?? null,
  }));
}

function parseCodexAttachmentContext(
  body: string,
  context: VisibleCodexUserContentContext,
  blockIndex: number,
): ChatAttachmentSummary[] {
  const attachments: ChatAttachmentSummary[] = [];
  for (const line of body.split(/\r?\n/)) {
    const match = CODEX_ATTACHMENT_LINE_PATTERN.exec(line);
    if (!match) continue;
    const name = match[1]?.trim();
    const mediaType = match[2]?.trim();
    const sizeBytes = parseAttachmentByteSize(match[3], match[4]);
    const kind = attachmentKind(match[5]);
    if (!name || !mediaType || sizeBytes === null || !kind) continue;

    const id = `${context.turnId}_attachment_${blockIndex + 1}_${attachments.length + 1}`;
    const localPath = match[6]?.trim() || localImagePathByName(name);
    const imagePreview = codexHistoryImagePreview({
      attachmentId: id,
      context,
      kind,
      localPath,
      mediaType,
    });
    attachments.push({
      id,
      name,
      mediaType,
      sizeBytes,
      kind,
      ...(imagePreview ? { imagePreview } : {}),
    });
  }
  return attachments;
}

function codexInputImageAttachments(
  inputImages: string[],
  references: CodexImageReference[],
  context: VisibleCodexUserContentContext,
  offset: number,
): ChatAttachmentSummary[] {
  const attachments: ChatAttachmentSummary[] = [];
  for (const [index, dataUrl] of inputImages.entries()) {
    const parsed = parseDataImageUrl(dataUrl);
    if (!parsed) continue;
    const reference = references[index];
    const name = imageAttachmentName(reference, parsed.contentType, index);
    const id = `${context.turnId}_input_image_${index + 1 + offset}`;
    const imagePreview = materializedCodexHistoryImagePreview({
      bytes: parsed.bytes,
      attachmentId: id,
      contentType: parsed.contentType,
      context,
      name,
    });
    attachments.push({
      id,
      name,
      mediaType: parsed.contentType,
      sizeBytes: parsed.bytes.byteLength,
      kind: "image",
      ...(imagePreview ? { imagePreview } : {}),
    });
  }
  return attachments;
}

function codexImageReferenceAttachments(
  references: CodexImageReference[],
  context: VisibleCodexUserContentContext,
  offset: number,
): ChatAttachmentSummary[] {
  const attachments: ChatAttachmentSummary[] = [];
  for (const [index, reference] of references.entries()) {
    const localPath = reference.localPath ?? null;
    if (!localPath) continue;
    const contentType = chatAttachmentImageContentType("", localPath);
    const bytes = readCodexHistoryImageBytes(localPath);
    if (!contentType || !bytes) continue;
    const name = imageAttachmentName(reference, contentType, index);
    const id = `${context.turnId}_image_reference_${index + 1 + offset}`;
    const imagePreview = materializedCodexHistoryImagePreview({
      bytes,
      attachmentId: id,
      contentType,
      context,
      name,
    });
    attachments.push({
      id,
      name,
      mediaType: contentType,
      sizeBytes: bytes.byteLength,
      kind: "image",
      ...(imagePreview ? { imagePreview } : {}),
    });
  }
  return attachments;
}

function codexHistoryImagePreview(input: {
  attachmentId: string;
  context: VisibleCodexUserContentContext;
  kind: ChatAttachmentSummary["kind"];
  localPath?: string;
  mediaType: string;
}): ChatAttachmentSummary["imagePreview"] | undefined {
  if (input.kind !== "image" || !input.localPath || !input.context.attachmentRootDir) return undefined;
  const storageName = path.basename(input.localPath);
  const contentType = chatAttachmentImageContentType(input.mediaType, storageName);
  if (!contentType) return undefined;

  const target = path.resolve(input.localPath);
  const expectedDir = path.resolve(
    input.context.attachmentRootDir,
    safeChatAttachmentPathSegment(input.context.sessionId),
    safeChatAttachmentPathSegment(input.context.turnId),
  );
  if (target === expectedDir || !target.startsWith(`${expectedDir}${path.sep}`)) {
    const bytes = readCodexHistoryImageBytes(input.localPath);
    return bytes
      ? materializedCodexHistoryImagePreview({
          attachmentId: input.attachmentId,
          bytes,
          contentType,
          context: input.context,
          name: storageName,
        })
      : undefined;
  }

  return {
    sessionId: input.context.sessionId,
    turnId: input.context.turnId,
    attachmentId: input.attachmentId,
    storageName,
    contentType,
  };
}

function materializedCodexHistoryImagePreview(input: {
  attachmentId: string;
  bytes: Buffer;
  contentType: string;
  context: VisibleCodexUserContentContext;
  name: string;
}): ChatAttachmentSummary["imagePreview"] | undefined {
  if (!input.context.attachmentRootDir || input.bytes.byteLength > MAX_CODEX_HISTORY_IMAGE_BYTES) return undefined;
  const storageName = uniqueCodexHistoryImageStorageName(input.attachmentId, input.name, input.contentType);
  const turnDir = path.join(
    input.context.attachmentRootDir,
    safeChatAttachmentPathSegment(input.context.sessionId),
    safeChatAttachmentPathSegment(input.context.turnId),
  );
  const target = path.join(turnDir, storageName);
  try {
    mkdirSync(turnDir, { recursive: true });
    if (!existsSync(target)) writeFileSync(target, input.bytes, { mode: 0o600 });
  } catch {
    return undefined;
  }
  return {
    sessionId: input.context.sessionId,
    turnId: input.context.turnId,
    attachmentId: input.attachmentId,
    storageName,
    contentType: input.contentType,
  };
}

function parseDataImageUrl(value: string): { bytes: Buffer; contentType: string } | null {
  const match = DATA_IMAGE_URL_PATTERN.exec(value.trim());
  if (!match) return null;
  const contentType = chatAttachmentImageContentType(match[1]!, "");
  if (!contentType) return null;
  const bytes = Buffer.from(match[2]!.replace(/\s+/g, ""), "base64");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_CODEX_HISTORY_IMAGE_BYTES) return null;
  return { bytes, contentType };
}

function readCodexHistoryImageBytes(localPath: string): Buffer | null {
  try {
    const stat = statSync(localPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_CODEX_HISTORY_IMAGE_BYTES) return null;
    return readFileSync(localPath);
  } catch {
    return null;
  }
}

function localImagePathByName(name: string): string | undefined {
  const candidates = [
    path.join(os.homedir(), "Pictures", "Screenshots", name),
    path.join(os.homedir(), "Pictures", name),
    path.join(os.homedir(), "Downloads", name),
    path.join(os.homedir(), "Desktop", name),
  ];
  return candidates.find((candidate) => {
    const contentType = chatAttachmentImageContentType("", candidate);
    if (!contentType) return false;
    try {
      const stat = statSync(candidate);
      return stat.isFile() && stat.size > 0 && stat.size <= MAX_CODEX_HISTORY_IMAGE_BYTES;
    } catch {
      return false;
    }
  });
}

function imageAttachmentName(
  reference: CodexImageReference | undefined,
  contentType: string,
  index: number,
): string {
  const localPathName = reference?.localPath ? path.basename(reference.localPath) : "";
  if (localPathName) return localPathName;
  const label = reference?.label?.trim();
  if (label) return `${label}${imageExtension(contentType)}`;
  return `image-${index + 1}${imageExtension(contentType)}`;
}

function uniqueCodexHistoryImageStorageName(attachmentId: string, name: string, contentType: string): string {
  const extension = path.extname(name) || imageExtension(contentType);
  const base = path.basename(name, path.extname(name)).replace(/[^a-zA-Z0-9._ -]+/g, "-").trim() || "image";
  return `${safeId(attachmentId)}-${base}${extension}`;
}

function imageExtension(contentType: string): string {
  if (contentType === "image/jpeg") return ".jpg";
  if (contentType === "image/gif") return ".gif";
  if (contentType === "image/webp") return ".webp";
  return ".png";
}

function parseAttachmentByteSize(amountText: string | undefined, unitText: string | undefined): number | null {
  if (!amountText || !unitText) return null;
  const amount = Number.parseFloat(amountText);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const unit = unitText.toUpperCase();
  const multipliers: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
    TB: 1024 ** 4,
  };
  const multiplier = multipliers[unit];
  return multiplier ? Math.round(amount * multiplier) : null;
}

function attachmentKind(value: string | undefined): ChatAttachmentSummary["kind"] | null {
  if (value === "image" || value === "text" || value === "file") return value;
  return null;
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
