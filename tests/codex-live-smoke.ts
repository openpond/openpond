import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createOpenPondServer } from "../apps/server/src/index";
import type { BootstrapPayload, Session, Turn } from "@openpond/contracts";

if (process.env.OPENPOND_APP_LIVE_CODEX !== "1") {
  console.log("set OPENPOND_APP_LIVE_CODEX=1 to run the live Codex app-server smoke");
  process.exit(0);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function api<T>(server: string, token: string, route: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${server}${route}`, { ...init, headers });
  if (!response.ok) throw new Error(`${route} failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

const storeDir = await mkdtemp(path.join(os.tmpdir(), "openpond-app-codex-"));
const instance = await createOpenPondServer({ port: 0, storeDir, silent: true });

try {
  const session = await api<Session>(instance.url, instance.token, "/v1/sessions", {
    method: "POST",
    body: JSON.stringify({
      provider: "codex",
      cwd: process.cwd(),
      title: "codex smoke",
    }),
  });
  const turn = await api<Turn>(instance.url, instance.token, `/v1/sessions/${session.id}/turns`, {
    method: "POST",
    body: JSON.stringify({
      prompt: "Reply exactly with no emojis: OpenPond App live smoke ok.",
      approvalPolicy: "never",
      sandbox: "read-only",
    }),
  });
  assert(turn.status === "completed", `turn should complete, got ${turn.status}`);
  const bootstrap = await api<BootstrapPayload>(instance.url, instance.token, "/v1/bootstrap");
  assert(
    bootstrap.events.some((event) => event.sessionId === session.id && event.name === "assistant.delta"),
    "assistant delta should be persisted"
  );
  assert(
    bootstrap.events.some((event) => event.sessionId === session.id && event.name === "turn.completed"),
    "turn completion should be persisted"
  );
  console.log("codex live smoke ok");
} finally {
  await instance.close();
  await rm(storeDir, { recursive: true, force: true });
}
