import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { BootstrapPayload } from "@openpond/contracts";

import { createOpenPondServer } from "../apps/server/src/index";

async function api<T>(
  serverUrl: string,
  token: string,
  route: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${serverUrl}${route}`, { ...init, headers });
  if (!response.ok) throw new Error(`${route} failed: ${response.status} ${await response.text()}`);
  return await response.json() as T;
}

describe("app preferences", () => {
  test("persists the auto context compaction toggle through bootstrap", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "openpond-context-compaction-preferences-"));
    const server = await createOpenPondServer({
      port: 0,
      storeDir,
      silent: true,
      version: "context-compaction-preferences-test",
    });

    try {
      const saved = await api<BootstrapPayload>(
        server.url,
        server.token,
        "/v1/preferences",
        {
          method: "PATCH",
          body: JSON.stringify({
            contextCompaction: {
              autoEnabled: false,
              triggerPercent: 85,
              summaryModel: "same_model",
            },
          }),
        },
      );
      expect(saved.preferences.contextCompaction).toEqual({
        autoEnabled: false,
        triggerPercent: 85,
        summaryModel: "same_model",
      });

      const bootstrap = await api<BootstrapPayload>(
        server.url,
        server.token,
        "/v1/bootstrap?ensureProfile=0",
      );
      expect(bootstrap.preferences.contextCompaction).toEqual(saved.preferences.contextCompaction);
    } finally {
      await server.close();
      await rm(storeDir, { recursive: true, force: true });
    }
  });
});
