import {
  ProviderIdSchema,
  type ProviderSettings,
  type TeamChatAiMessage,
  type TeamChatAiTurn,
  type TeamChatHostedAiThread,
} from "@openpond/contracts";
import type { HostedChatMessage } from "@openpond/cloud";
import {
  CodexAppServerClient,
  defaultServerRequestResult,
  type CodexNotification,
} from "@openpond/codex-provider";

import {
  isOpenAiCompatibleProviderId,
  streamOpenAiCompatibleChatCompletion,
} from "./openai-compatible-provider.js";
import type { ProviderSecrets } from "./provider-secrets.js";
import { teamChatRequestPayload } from "./team-chat-client.js";
import { extractDelta } from "../utils.js";

type ProviderRuntime = {
  settings: ProviderSettings;
  secrets: ProviderSecrets;
};

type ActiveExecution = {
  controller: AbortController;
  codexClient: CodexAppServerClient | null;
  teamId: string;
  cancelled: boolean;
};

const PARTIAL_PUBLISH_INTERVAL_MS = 750;
const PARTIAL_PUBLISH_CHARS = 1_024;

export function createTeamChatAiExecutionService(input: {
  loadProviderRuntime: () => Promise<ProviderRuntime>;
  version: string;
}) {
  const active = new Map<string, ActiveExecution>();

  function execute(turnId: string, teamId: string): { accepted: true } {
    if (active.has(turnId)) return { accepted: true };
    const execution: ActiveExecution = {
      controller: new AbortController(),
      codexClient: null,
      teamId,
      cancelled: false,
    };
    active.set(turnId, execution);
    void run(turnId, execution).finally(() => {
      if (active.get(turnId) === execution) active.delete(turnId);
    });
    return { accepted: true };
  }

  async function cancel(turnId: string, teamId?: string): Promise<{ cancelled: boolean }> {
    const execution = active.get(turnId);
    if (!execution) {
      if (!teamId) return { cancelled: false };
      await teamChatRequestPayload({ type: "ai_turn_cancel", teamId, turnId });
      return { cancelled: true };
    }
    execution.cancelled = true;
    execution.controller.abort(new Error("team_chat_ai_turn_cancelled"));
    await execution.codexClient?.stop().catch(() => undefined);
    await teamChatRequestPayload({
      type: "ai_turn_cancel",
      teamId: execution.teamId,
      turnId,
    }).catch(() => undefined);
    return { cancelled: true };
  }

  async function run(turnId: string, execution: ActiveExecution): Promise<void> {
    let claimed: TeamChatAiTurn | null = null;
    try {
      claimed = (await teamChatRequestPayload({
        type: "ai_turn_claim",
        teamId: execution.teamId,
        turnId,
        leaseSeconds: 90,
      })) as TeamChatAiTurn;
      const thread = (await teamChatRequestPayload({
        type: "ai_thread",
        teamId: execution.teamId,
        conversationId: claimed.conversationId,
      })) as TeamChatHostedAiThread;
      const publisher = createTeamChatPartialPublisher({
        teamId: execution.teamId,
        turnId,
      });
      const body =
        claimed.providerId === "codex"
          ? await runCodexTurn({
              execution,
              modelId: claimed.modelId,
              thread,
              version: input.version,
              onText: publisher.append,
            })
          : await runByokTurn({
              execution,
              providerId: claimed.providerId,
              modelId: claimed.modelId,
              runtime: await input.loadProviderRuntime(),
              thread,
              onText: publisher.append,
            });
      if (execution.cancelled) return;
      await publisher.flush();
      if (!body.trim()) throw new Error("team_chat_ai_empty_response");
      await teamChatRequestPayload({
        type: "ai_turn_complete",
        teamId: execution.teamId,
        turnId,
        body,
      });
    } catch (error) {
      if (execution.cancelled) return;
      await teamChatRequestPayload({
        type: "ai_turn_fail",
        teamId: execution.teamId,
        turnId,
        errorCode: execution.controller.signal.aborted
          ? "executor_interrupted"
          : executionErrorCode(error),
        interrupted: execution.controller.signal.aborted,
      }).catch(() => undefined);
    } finally {
      await execution.codexClient?.stop().catch(() => undefined);
      execution.codexClient = null;
      void claimed;
    }
  }

  return { execute, cancel, activeTurnIds: () => Array.from(active.keys()) };
}

async function runByokTurn(input: {
  execution: ActiveExecution;
  providerId: string;
  modelId: string;
  runtime: ProviderRuntime;
  thread: TeamChatHostedAiThread;
  onText: (body: string) => Promise<void>;
}): Promise<string> {
  const providerId = ProviderIdSchema.parse(input.providerId);
  if (!isOpenAiCompatibleProviderId(providerId)) {
    throw new Error(`team_chat_provider_not_local:${providerId}`);
  }
  let body = "";
  for await (const delta of streamOpenAiCompatibleChatCompletion({
    providerId,
    settings: input.runtime.settings,
    secrets: input.runtime.secrets,
    modelId: input.modelId,
    messages: hostedMessages(input.thread.messages),
    requestId: input.thread.activeTurn?.id,
    signal: input.execution.controller.signal,
  })) {
    if (delta.type !== "text_delta" || !delta.text) continue;
    body += delta.text;
    await input.onText(body);
  }
  return body;
}

async function runCodexTurn(input: {
  execution: ActiveExecution;
  modelId: string;
  thread: TeamChatHostedAiThread;
  version: string;
  onText: (body: string) => Promise<void>;
}): Promise<string> {
  let body = "";
  let partialQueue = Promise.resolve();
  const client = new CodexAppServerClient({
    binaryPath: process.env.CODEX_BINARY || "codex",
    clientName: "openpond-app",
    clientTitle: "OpenPond App",
    clientVersion: input.version,
    onNotification: (notification) => {
      const delta = codexTextDelta(notification);
      if (!delta) return;
      body += delta;
      partialQueue = partialQueue.then(() => input.onText(body));
    },
    onServerRequest: async (request) => defaultServerRequestResult(request),
  });
  input.execution.codexClient = client;
  const thread = await client.startThread({
    cwd: process.cwd(),
    model: input.modelId,
    approvalPolicy: "never",
    sandbox: "read-only",
    config: {
      "tools.web_search": true,
      "tools.view_image": true,
      "features.web_search_request": true,
    },
    developerInstructions: [
      "You are replying inside a shared OpenPond team conversation.",
      "The canonical transcript is hosted and visible to all thread participants.",
      "Answer the latest user message directly. Do not mention transcript reconstruction.",
      "Do not expose credentials or private local-machine state.",
    ].join("\n"),
  });
  const turn = await client.startTurn({
    threadId: thread.threadId,
    prompt: codexTranscriptPrompt(input.thread.messages),
    cwd: process.cwd(),
    model: input.modelId,
    approvalPolicy: "never",
    sandbox: "read-only",
  });
  const completion = await client.waitForTurn(turn.turnId);
  await partialQueue;
  return body || completionText(completion) || "";
}

export function createTeamChatPartialPublisher(input: {
  teamId: string;
  turnId: string;
  request?: typeof teamChatRequestPayload;
  now?: () => number;
}) {
  const request = input.request ?? teamChatRequestPayload;
  const now = input.now ?? Date.now;
  let latestBody = "";
  let lastPublishedBody = "";
  let lastPublishedAt = 0;
  let queue = Promise.resolve();

  async function append(body: string): Promise<void> {
    latestBody = body;
    const currentTime = now();
    if (
      currentTime - lastPublishedAt < PARTIAL_PUBLISH_INTERVAL_MS &&
      body.length - lastPublishedBody.length < PARTIAL_PUBLISH_CHARS
    ) {
      return;
    }
    await publish();
  }

  async function publish(): Promise<void> {
    if (!latestBody || latestBody === lastPublishedBody) return;
    const body = latestBody;
    lastPublishedAt = now();
    lastPublishedBody = body;
    queue = queue.then(async () => {
      await request({
        type: "ai_turn_partial",
        teamId: input.teamId,
        turnId: input.turnId,
        body,
        leaseSeconds: 90,
      });
    });
    await queue;
  }

  return {
    append,
    async flush() {
      await publish();
      await queue;
    },
  };
}

function hostedMessages(messages: TeamChatAiMessage[]): HostedChatMessage[] {
  const result: HostedChatMessage[] = [
    {
      role: "system",
      content: [
        "You are replying inside a shared OpenPond team conversation.",
        "The canonical transcript is visible to all participants.",
        "Answer the latest user message directly and do not expose local credentials.",
      ].join("\n"),
    },
  ];
  for (const message of messages) {
    if (message.role === "user" || message.role === "assistant" || message.role === "system") {
      result.push({ role: message.role, content: message.body });
    }
  }
  return result;
}

function codexTranscriptPrompt(messages: TeamChatAiMessage[]): string {
  return [
    "Shared conversation transcript:",
    ...messages.map((message) => `${message.role.toUpperCase()}: ${message.body}`),
    "Respond to the latest USER message.",
  ].join("\n\n");
}

function codexTextDelta(notification: CodexNotification): string {
  return notification.method === "item/agentMessage/delta" ? extractDelta(notification.params) : "";
}

function completionText(value: unknown): string | null {
  const seen = new Set<unknown>();
  function visit(current: unknown, depth: number): string | null {
    if (depth > 8 || current == null || seen.has(current)) return null;
    if (typeof current === "string") return current.trim() || null;
    if (typeof current !== "object") return null;
    seen.add(current);
    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) {
        const found = visit(current[index], depth + 1);
        if (found) return found;
      }
      return null;
    }
    const record = current as Record<string, unknown>;
    for (const key of ["text", "outputText", "message", "content"]) {
      const found = visit(record[key], depth + 1);
      if (found) return found;
    }
    return null;
  }
  return visit(value, 0);
}

function executionErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[^a-zA-Z0-9:_-]+/g, "_").slice(0, 200) || "team_chat_ai_execution_failed";
}
