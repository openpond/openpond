import type { ResponseItem } from "./types.js";

export type StreamCallbacks = {
  onTextDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
  onConversationId?: (id: string) => void;
  onItems?: (items: ResponseItem[]) => void;
  onUsage?: (usage: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  }) => void;
  shouldStop?: () => boolean;
  onStop?: () => void;
};

export function normalizeDataFrames(raw: unknown): {
  conversationId?: string;
  items: ResponseItem[];
} {
  const frames = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as any).data)
    ? ((raw as any).data as unknown[])
    : [raw];
  const items: ResponseItem[] = [];
  let conversationId: string | undefined;

  for (const frame of frames) {
    if (!frame || typeof frame !== "object") continue;
    const typed = frame as Record<string, unknown>;
    const type = typeof typed.type === "string" ? typed.type : undefined;

    if (type === "conversation-created") {
      const cid = typed.conversationId;
      if (typeof cid === "string") {
        conversationId = cid;
      }
      continue;
    }

    if (type === "response_items" && Array.isArray(typed.items)) {
      items.push(...(typed.items as ResponseItem[]));
      continue;
    }

    if (type === "response_item" && typed.item) {
      items.push(typed.item as ResponseItem);
      continue;
    }

    if (type === "assistant-message" && typeof typed.content === "string") {
      items.push({
        type: "message",
        role: "assistant",
        id: `assistant-${Date.now()}`,
        content: [{ type: "markdown", text: typed.content as string }],
        createdAt:
          typeof typed.createdAt === "string"
            ? (typed.createdAt as string)
            : new Date().toISOString(),
      });
    }
  }

  return { conversationId, items };
}

function extractUsage(raw: unknown): {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
} | null {
  const frames = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as any).data)
    ? ((raw as any).data as unknown[])
    : [raw];

  for (const frame of frames) {
    if (!frame || typeof frame !== "object") continue;
    const typed = frame as Record<string, unknown>;
    if (typed.type !== "usage") continue;
    const usage = typed.usage as Record<string, unknown> | undefined;
    if (!usage) continue;
    const promptTokens =
      typeof usage.promptTokens === "number"
        ? usage.promptTokens
        : typeof usage.prompt_tokens === "number"
        ? usage.prompt_tokens
        : undefined;
    const completionTokens =
      typeof usage.completionTokens === "number"
        ? usage.completionTokens
        : typeof usage.completion_tokens === "number"
        ? usage.completion_tokens
        : undefined;
    const totalTokens =
      typeof usage.totalTokens === "number"
        ? usage.totalTokens
        : typeof usage.total_tokens === "number"
        ? usage.total_tokens
        : undefined;
    return { promptTokens, completionTokens, totalTokens };
  }

  return null;
}

export async function consumeStream(
  response: Response,
  callbacks: StreamCallbacks
): Promise<void> {
  if (!response.body) {
    throw new Error("Missing response body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let remainder = "";

  const shouldStop = callbacks.shouldStop;
  const stopIfNeeded = async (): Promise<boolean> => {
    if (!shouldStop || !shouldStop()) {
      return false;
    }
    try {
      await reader.cancel();
    } catch {
      // ignore cancel errors
    }
    callbacks.onStop?.();
    return true;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    const textChunk = remainder + chunk;
    const lines = textChunk.split("\n");
    remainder = lines.pop() || "";

    for (const line of lines) {
      if (!line) continue;
      if (line.startsWith("0:")) {
        const payload = line.slice(2).trim();
        if (!payload) continue;
        const delta = JSON.parse(payload);
        if (typeof delta === "string") {
          callbacks.onTextDelta?.(delta);
        }
        continue;
      }

      if (line.startsWith("g:")) {
        const payload = line.slice(2).trim();
        if (!payload) continue;
        const delta = JSON.parse(payload);
        if (typeof delta === "string") {
          callbacks.onReasoningDelta?.(delta);
        }
        continue;
      }

      if (line.startsWith("d:")) {
        continue;
      }

      if (line.startsWith("3:")) {
        const payload = line.slice(2).trim();
        if (!payload) continue;
        try {
          const message = JSON.parse(payload);
          if (typeof message === "string") {
            throw new Error(message);
          }
        } catch {
          // Ignore malformed error frames (can be truncated).
        }
        continue;
      }

      if (line.startsWith("2:")) {
        const payload = line.slice(2).trim();
        if (!payload) continue;
        try {
          const dataItems = JSON.parse(payload);
          const usage = extractUsage(dataItems);
          if (usage) {
            callbacks.onUsage?.(usage);
          }
          const { conversationId, items } = normalizeDataFrames(dataItems);
          if (conversationId) {
            callbacks.onConversationId?.(conversationId);
          }
          if (items.length > 0) {
            await Promise.resolve(callbacks.onItems?.(items));
          }
          if (await stopIfNeeded()) {
            return;
          }
        } catch {
          // Ignore malformed data frames (can be truncated).
        }
      }
      if (await stopIfNeeded()) {
        return;
      }
    }
  }
}

export function formatStreamItem(item: ResponseItem): string | null {
  if (!item || typeof item !== "object") return null;
  const type = (item as any).type;
  if (typeof type !== "string") return null;

  if (type === "app_creation_started") {
    const name =
      (item as any).appName ||
      (item as any).name ||
      (item as any).appId ||
      "app";
    const templateRepoUrl =
      typeof (item as any).templateRepoUrl === "string"
        ? (item as any).templateRepoUrl
        : null;
    const suffix = templateRepoUrl ? ` template=${templateRepoUrl}` : "";
    return `app_creation_started: ${name}${suffix}`;
  }

  if (type === "app_created") {
    const appId =
      typeof (item as any).appId === "string" ? (item as any).appId : "unknown";
    const name =
      typeof (item as any).appName === "string" ? (item as any).appName : null;
    return name ? `app_created: ${name} (${appId})` : `app_created: ${appId}`;
  }

  if (type.startsWith("tool_creation_")) {
    const message = (item as any).message || (item as any).content || "";
    return message ? `${type}: ${message}` : type;
  }

  return null;
}
