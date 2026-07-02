import { appendFile, mkdir, writeFile } from "node:fs/promises";

const MODEL = "deepseek-v4-flash";
const STREAM_PATH = "artifacts/stream-events.jsonl";
const WORKFLOW_PATH = "artifacts/workflow-events.jsonl";
const STATE_PATH = "artifacts/conversation-state.json";

type LifecycleHint =
  | { kind: "activity" }
  | { kind: "dirty"; dirtyKind: "workflow" }
  | { kind: "checkpoint"; reason?: string }
  | { kind: "waiting_for_user"; reason?: string };

async function appendJsonLine(path: string, value: Record<string, unknown>) {
  await appendFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

async function postWorkspaceEvent(event: Record<string, unknown>) {
  const workspaceId = process.env.OPENPOND_AGENT_WORKSPACE_ID?.trim();
  const apiKey = process.env.OPENPOND_API_KEY?.trim();
  if (!workspaceId || !apiKey) return;

  const baseUrl = process.env.OPENPOND_API_URL?.trim() || "https://api.openpond.ai";
  const response = await fetch(
    `${baseUrl.replace(/\/$/, "")}/v1/agent-workspaces/${encodeURIComponent(workspaceId)}/events`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(event),
    },
  );
  if (!response.ok) {
    throw new Error(`workspace event failed with HTTP ${response.status}`);
  }
}

async function emitWorkflowEvent(
  type: string,
  summary: string,
  lifecycleHint: LifecycleHint,
  payload: Record<string, unknown> = {},
) {
  const event = {
    type,
    summary,
    payload,
    lifecycleHint,
    createdAt: new Date().toISOString(),
  };
  await appendJsonLine(WORKFLOW_PATH, event);
  await postWorkspaceEvent(event);
}

async function readLiveDeepSeekStream(prompt: string): Promise<string> {
  const apiKey = process.env.DEEPSEEK_API_KEY_SANDBOX?.trim();
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY_SANDBOX is required for live DeepSeek smoke");
  }

  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok || !response.body) {
    throw new Error(`DeepSeek stream failed with HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice("data:".length).trim();
      if (data === "[DONE]") continue;
      const parsed = JSON.parse(data) as {
        choices?: Array<{ delta?: { content?: string } }>;
      };
      const delta = parsed.choices?.[0]?.delta?.content ?? "";
      if (delta) {
        content += delta;
        await appendJsonLine(STREAM_PATH, {
          type: "delta",
          model: MODEL,
          bytes: delta.length,
          createdAt: new Date().toISOString(),
        });
      }
    }
  }

  return content;
}

async function readMockStream(): Promise<string> {
  const chunks = ["Checkpoint ", "idle ", "compute."];
  let content = "";
  for (const chunk of chunks) {
    content += chunk;
    await appendJsonLine(STREAM_PATH, {
      type: "delta",
      model: MODEL,
      bytes: chunk.length,
      mock: true,
      createdAt: new Date().toISOString(),
    });
  }
  return content;
}

await mkdir("artifacts", { recursive: true });
await writeFile(STREAM_PATH, "", "utf8");
await writeFile(WORKFLOW_PATH, "", "utf8");

const prompt =
  process.env.DEEPSEEK_PROMPT?.trim() || "Reply with one short sentence about checkpointing.";

await emitWorkflowEvent("workflow.step_started", "DeepSeek stream started", {
  kind: "activity",
});

const live = process.env.DEEPSEEK_LIVE === "1";
const assistantContent = live ? await readLiveDeepSeekStream(prompt) : await readMockStream();

const state = {
  template: "deepseek-v4-flash-sandbox-template",
  provider: "deepseek",
  model: MODEL,
  live,
  prompt,
  assistantContent,
  secretRef: "DEEPSEEK_API_KEY_SANDBOX",
  rawSecretPersisted: false,
  streamCompletedAt: new Date().toISOString(),
};

await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
await emitWorkflowEvent(
  "workflow.step_completed",
  "DeepSeek stream completed",
  { kind: "dirty", dirtyKind: "workflow" },
  { model: MODEL, artifactRefs: [STATE_PATH, STREAM_PATH] },
);

export {};
