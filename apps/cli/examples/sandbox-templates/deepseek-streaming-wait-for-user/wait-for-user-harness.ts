import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";

const WORKFLOW_PATH = "artifacts/workflow-events.jsonl";
const WAIT_PATH = "artifacts/wait-for-user.json";
const STATE_PATH = "artifacts/conversation-state.json";

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
  lifecycleHint: Record<string, unknown>,
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

async function transitionWorkspaceToWaitingForUser() {
  const workspaceId = process.env.OPENPOND_AGENT_WORKSPACE_ID?.trim();
  const apiKey = process.env.OPENPOND_API_KEY?.trim();
  if (!workspaceId || !apiKey) return;

  const baseUrl = process.env.OPENPOND_API_URL?.trim() || "https://api.openpond.ai";
  const workspaceResponse = await fetch(
    `${baseUrl.replace(/\/$/, "")}/v1/agent-workspaces/${encodeURIComponent(workspaceId)}`,
    { headers: { authorization: `Bearer ${apiKey}` } },
  );
  if (!workspaceResponse.ok) {
    throw new Error(`workspace fetch failed with HTTP ${workspaceResponse.status}`);
  }
  const workspacePayload = (await workspaceResponse.json()) as {
    workspace?: { version?: number };
  };
  const expectedVersion = workspacePayload.workspace?.version;
  if (typeof expectedVersion !== "number") {
    throw new Error("workspace response did not include a numeric version");
  }

  const response = await fetch(
    `${baseUrl.replace(/\/$/, "")}/v1/agent-workspaces/${encodeURIComponent(workspaceId)}/status`,
    {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        status: "waiting_for_user",
        expectedVersion,
        summary: "DeepSeek chat turn is waiting for user input",
        metadata: {
          lifecycleReason: "waiting_for_user",
          workflowWaitForUserReason: "chat_turn_complete",
        },
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`workspace waiting transition failed with HTTP ${response.status}`);
  }
}

await mkdir("artifacts", { recursive: true });
try {
  await import("./deepseek-chat-stream");
} catch (error) {
  await emitWorkflowEvent(
    "workflow.step_failed",
    "DeepSeek stream failed",
    { kind: "checkpoint", reason: "stream_failed" },
    { error: error instanceof Error ? error.message : "unknown" },
  );
  throw error;
}

const state = JSON.parse(await readFile(STATE_PATH, "utf8")) as {
  model?: string;
};
const userReply = process.env.USER_REPLY?.trim() || "";
const timeoutMs = Number(process.env.WAIT_FOR_USER_TIMEOUT_MS ?? "1000");

await emitWorkflowEvent(
  "workflow.waiting_for_user",
  "DeepSeek chat turn is waiting for user input",
  { kind: "waiting_for_user", reason: "chat_turn_complete" },
  { model: state.model, secretRef: "DEEPSEEK_API_KEY_SANDBOX" },
);
await transitionWorkspaceToWaitingForUser();

let finalState: Record<string, unknown>;
if (userReply) {
  await emitWorkflowEvent(
    "workflow.step_started",
    "User replied before wait timeout",
    { kind: "activity" },
    { replyBytes: userReply.length },
  );
  finalState = {
    replyReceived: true,
    stoppedForIdleWait: false,
    checkpointExpected: false,
  };
} else {
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  await emitWorkflowEvent(
    "workflow.checkpoint_hint",
    "No user reply before timeout; checkpoint before stop",
    { kind: "checkpoint", reason: "no_user_reply_timeout" },
    { timeoutMs },
  );
  finalState = {
    replyReceived: false,
    stoppedForIdleWait: true,
    checkpointExpected: true,
  };
}

await writeFile(
  WAIT_PATH,
  `${JSON.stringify(
    {
      template: "deepseek-v4-flash-sandbox-template",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      secretRef: "DEEPSEEK_API_KEY_SANDBOX",
      rawSecretPersisted: false,
      ...finalState,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

export {};
