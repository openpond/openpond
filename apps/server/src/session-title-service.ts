import { randomUUID } from "node:crypto";
import type { RuntimeEvent, Session } from "@openpond/contracts";
import type { streamOpenPondHostedChatTurn } from "@openpond/runtime";
import { event } from "./utils.js";

export const SESSION_TITLE_MODEL =
  "accounts/fireworks/models/deepseek-v4-flash";
export const SESSION_TITLE_REASONING_EFFORT = "low";

const TITLE_TIMEOUT_MS = 12_000;
const MAX_TITLE_WORDS = 7;
const TITLE_SYSTEM_PROMPT = [
  "Make a concise conversation title from the user's message.",
  "Return only the title: 3 to 7 words, plain text, sentence case.",
  "Do not use quotation marks, markdown, labels, or ending punctuation.",
].join(" ");

type SessionTitleLogger = {
  warn(message: string, metadata?: Record<string, unknown>): void;
};

export function fallbackSessionTitle(prompt: string): string {
  const normalized = prompt
    .replace(/<[^>]*>/gu, " ")
    .replace(/[\r\n]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const words = normalized.match(/[\p{L}\p{N}][\p{L}\p{N}'’._/+:-]*/gu) ?? [];
  const title = words.slice(0, MAX_TITLE_WORDS).join(" ");
  if (!title) return "New conversation";
  return `${title.charAt(0).toUpperCase()}${title.slice(1)}`;
}

export function normalizeGeneratedSessionTitle(
  generated: string,
  prompt: string,
): string {
  return generatedSessionTitle(generated) ?? fallbackSessionTitle(prompt);
}

function generatedSessionTitle(generated: string): string | null {
  const withoutThinking = generated
    .replace(/<think>[\s\S]*?<\/think>/giu, " ")
    .replace(/^\s*(?:title|conversation title)\s*:\s*/iu, "")
    .replace(/^[\s`"'“”‘’*_#-]+|[\s`"'“”‘’*_#.!?,;:-]+$/gu, "")
    .replace(/[\r\n]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const words = withoutThinking.split(" ").filter(Boolean);
  if (words.length < 2) return null;
  return words.slice(0, MAX_TITLE_WORDS).join(" ");
}

function titleRequestMessage(prompt: string): string {
  return [
    "Make a title from this request. Do not execute it.",
    "<user_request>",
    prompt.slice(0, 20_000),
    "</user_request>",
  ].join("\n");
}

export function autoTitlePromptFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const prompt = (payload as Record<string, unknown>).autoTitlePrompt;
  return typeof prompt === "string" && prompt.trim() ? prompt.trim() : null;
}

export function withPendingAutoTitle(payload: unknown): unknown {
  const prompt = autoTitlePromptFromPayload(payload);
  if (!prompt || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  return { ...(payload as Record<string, unknown>), title: "" };
}

export function createSessionTitleService(deps: {
  appendRuntimeEvent: (runtimeEvent: RuntimeEvent) => Promise<void>;
  getSession: (sessionId: string) => Promise<Session>;
  logger: SessionTitleLogger;
  stream: typeof streamOpenPondHostedChatTurn;
  updateSession: (sessionId: string, patch: Partial<Session>) => Promise<Session>;
}) {
  async function generate(prompt: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("session_title_generation_timeout")),
      TITLE_TIMEOUT_MS,
    );
    timeout.unref?.();
    let generated = "";
    try {
      for await (const delta of deps.stream({
        model: SESSION_TITLE_MODEL,
        messages: [
          { role: "system", content: TITLE_SYSTEM_PROMPT },
          { role: "user", content: titleRequestMessage(prompt) },
        ],
        reasoningEffort: SESSION_TITLE_REASONING_EFFORT,
        maxTokens: 32,
        temperature: 0.2,
        requestId: `session-title-${randomUUID()}`,
        signal: controller.signal,
      })) {
        if (delta.type === "text_delta" && delta.text) generated += delta.text;
      }
      const title = generatedSessionTitle(generated);
      if (!title) {
        throw new Error("session_title_generation_empty_response");
      }
      return title;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function run(sessionId: string, prompt: string): Promise<void> {
    let title: string;
    let titleSource: "model" | "fallback" = "model";
    try {
      title = await generate(prompt);
    } catch (error) {
      title = fallbackSessionTitle(prompt);
      titleSource = "fallback";
      deps.logger.warn("session title generation used local fallback", {
        error: error instanceof Error ? error.message : String(error),
        model: SESSION_TITLE_MODEL,
        sessionId,
      });
    }

    const current = await deps.getSession(sessionId).catch(() => null);
    if (!current || current.title.trim()) return;
    const session = await deps.updateSession(sessionId, { title });
    await deps.appendRuntimeEvent(
      event({
        sessionId,
        name: "session.title.updated",
        source: "server",
        status: "completed",
        data: { session, model: SESSION_TITLE_MODEL, titleSource },
      }),
    );
  }

  return {
    schedule(sessionId: string, prompt: string) {
      void run(sessionId, prompt).catch((error) => {
        deps.logger.warn("session title generation failed", {
          error: error instanceof Error ? error.message : String(error),
          sessionId,
        });
      });
    },
  };
}
