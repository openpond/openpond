import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createOpenPondServer } from "../apps/server/src/index";
import type { BootstrapPayload, Session } from "@openpond/contracts";

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

const storeDir = await mkdtemp(path.join(os.tmpdir(), "openpond-app-smoke-"));
const instance = await createOpenPondServer({ port: 0, storeDir, silent: true });

try {
  const health = await fetch(`${instance.url}/health`);
  assert(health.ok, "health endpoint should be public and healthy");

  const unauthorized = await fetch(`${instance.url}/v1/bootstrap`);
  assert(unauthorized.status === 401, "bootstrap should require the capability token");

  const bootstrap = await api<BootstrapPayload>(instance.url, instance.token, "/v1/bootstrap?refreshCodex=1");
  assert(bootstrap.server.port === instance.status.port, "bootstrap should report the actual server port");
  assert(bootstrap.account.balanceLabel === "$0.00", "account chip balance placeholder should be $0.00");
  assert(bootstrap.codex.available, "Codex CLI should be detected");
  assert(Array.isArray(bootstrap.apps), "OpenPond apps should be represented as a list");
  assert(bootstrap.placeholders.length >= 9, "workspace placeholder panes should be present");

  const app = bootstrap.apps[0] ?? null;
  const session = await api<Session>(instance.url, instance.token, "/v1/sessions", {
    method: "POST",
    body: JSON.stringify({
      provider: "codex",
      appId: app?.id ?? null,
      appName: app?.name ?? null,
      cwd: process.cwd(),
      title: "smoke",
    }),
  });
  assert(session.id, "session should be created");

  const action = await api<{ output?: string }>(instance.url, instance.token, `/v1/sessions/${session.id}/openpond-actions`, {
    method: "POST",
    body: JSON.stringify({ action: "refresh.apps", source: "terminal_command" }),
  });
  assert(typeof action.output === "string", "OpenPond refresh action should return timeline output");

  const after = await api<BootstrapPayload>(instance.url, instance.token, "/v1/bootstrap");
  assert(after.events.some((event) => event.name === "session.started"), "session event should be persisted");
  assert(after.events.some((event) => event.name === "workspace_action_result"), "OpenPond action result should be persisted");

  console.log("smoke ok");
} finally {
  await instance.close();
  await rm(storeDir, { recursive: true, force: true });
}
