import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  collectDesktopDiagnostics,
  type DesktopDiagnosticsSummary,
} from "../apps/desktop/src/desktop-diagnostics-collector";
import { createOpenPondServer } from "../apps/server/src/index";

function desktopSummary(): DesktopDiagnosticsSummary {
  return {
    app: "openpond",
    version: "0.0.5",
    releaseChannel: "stable",
    packaged: false,
    platform: "linux",
    arch: "x64",
    appHome: "/tmp/openpond-app",
    logDir: "/tmp/openpond-app/logs",
    createdAt: "2026-07-01T00:00:00.000Z",
  };
}

describe("desktop diagnostics collector", () => {
  test("collects server health, bootstrap size, route timings, and store metadata without leaking the token", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    let now = 1_000;
    const snapshot = await collectDesktopDiagnostics({
      desktop: desktopSummary(),
      logs: { lineLimit: 1000, lines: 2 },
      resources: {
        serverProcess: {
          activePid: 4321,
          sampleIntervalMs: 5000,
          maxSamples: 2,
          lastError: null,
          samples: [
            {
              sampledAt: "2026-07-01T00:00:02.000Z",
              rootPid: 4321,
              processCount: 2,
              cpuPercent: 7.5,
              rssBytes: 4096,
              processes: [
                { pid: 4321, ppid: 1, cpuPercent: 5, rssBytes: 2048 },
                { pid: 4322, ppid: 4321, cpuPercent: 2.5, rssBytes: 2048 },
              ],
            },
          ],
        },
      },
      serverConnection: {
        serverUrl: "http://127.0.0.1:17874/ignored?token=not-used#hash",
        token: "server-capability-token",
      },
      now: () => {
        now += 25;
        return now;
      },
      fetchImpl: async (url, init) => {
        const headers = new Headers(init?.headers);
        calls.push({ url: String(url), authorization: headers.get("authorization") });
        if (String(url).endsWith("/health")) {
          return Response.json({
            ok: true,
            server: "openpond-app-server",
            version: "0.0.5",
            runtimeVersion: "1.3.13",
          });
        }
        if (String(url).endsWith("/v1/bootstrap?ensureProfile=0")) {
          return Response.json({
            server: {
              id: "server_1",
              host: "127.0.0.1",
              port: 17874,
              startedAt: "2026-07-01T00:00:01.000Z",
              storePath: "/tmp/openpond-app/store.sqlite",
              version: "0.0.5",
              runtimeVersion: "1.3.13",
            },
          });
        }
        if (String(url).endsWith("/v1/diagnostics/providers")) {
          return Response.json({
            providerPayloadBytes: 512,
            modelCacheBytes: 128,
            modelCacheModelCount: 3,
            providerErrorCount: 0,
            modelCacheErrorCount: 0,
            credentialErrorCount: 1,
            recentOperations: [],
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    expect(calls).toEqual([
      { url: "http://127.0.0.1:17874/health", authorization: null },
      {
        url: "http://127.0.0.1:17874/v1/bootstrap?ensureProfile=0",
        authorization: "Bearer server-capability-token",
      },
      {
        url: "http://127.0.0.1:17874/v1/diagnostics/providers",
        authorization: "Bearer server-capability-token",
      },
    ]);
    expect(snapshot.server.configured).toBe(true);
    expect(snapshot.server.serverUrl).toBe("http://127.0.0.1:17874");
    expect(snapshot.server.health).toMatchObject({
      ok: true,
      status: 200,
      durationMs: 25,
    });
    expect(snapshot.server.bootstrap?.ok).toBe(true);
    expect(snapshot.server.bootstrap?.status).toBe(200);
    expect(snapshot.server.bootstrap?.responseBytes).toBeGreaterThan(0);
    expect(snapshot.server.providers?.payload).toMatchObject({
      providerPayloadBytes: 512,
      modelCacheBytes: 128,
      credentialErrorCount: 1,
    });
    expect(snapshot.server.store).toEqual({
      storePath: "/tmp/openpond-app/store.sqlite",
      serverId: "server_1",
      host: "127.0.0.1",
      port: 17874,
      startedAt: "2026-07-01T00:00:01.000Z",
      version: "0.0.5",
      runtimeVersion: "1.3.13",
    });
    expect(snapshot.logs).toEqual({ lineLimit: 1000, lines: 2 });
    expect(snapshot.resources?.serverProcess).toMatchObject({
      activePid: 4321,
      maxSamples: 2,
      samples: [
        {
          processCount: 2,
          cpuPercent: 7.5,
          rssBytes: 4096,
        },
      ],
    });
    expect(JSON.stringify(snapshot)).not.toContain("server-capability-token");
  });

  test("does not fetch server routes when no connection is available", async () => {
    let fetches = 0;
    const snapshot = await collectDesktopDiagnostics({
      desktop: desktopSummary(),
      requests: {
        localRpc: {
          slowThresholdMs: 100,
          stuckThresholdMs: 500,
          pendingCount: 1,
          recentSlowRequests: [],
          stuckRequests: [
            {
              id: 1,
              channel: "openpond:browser:navigate",
              startedAt: "2026-07-01T00:00:01.000Z",
              durationMs: 600,
              status: "pending",
            },
          ],
        },
      },
      resources: {
        serverProcess: {
          activePid: 123,
          sampleIntervalMs: 5_000,
          maxSamples: 2,
          samples: [
            {
              sampledAt: "2026-07-01T00:00:02.000Z",
              rootPid: 123,
              processCount: 2,
              cpuPercent: 4.5,
              rssBytes: 12_288,
              processes: [
                { pid: 123, ppid: 1, cpuPercent: 3, rssBytes: 8_192 },
                { pid: 124, ppid: 123, cpuPercent: 1.5, rssBytes: 4_096 },
              ],
            },
          ],
          lastError: null,
        },
      },
      logs: { lineLimit: 1000, lines: 0 },
      fetchImpl: async () => {
        fetches += 1;
        return Response.json({});
      },
    });

    expect(fetches).toBe(0);
    expect(snapshot.server).toEqual({ configured: false });
    expect(snapshot.requests?.localRpc?.stuckRequests[0]?.channel).toBe("openpond:browser:navigate");
    expect(snapshot.resources?.serverProcess?.samples[0]).toMatchObject({
      rootPid: 123,
      processCount: 2,
      cpuPercent: 4.5,
      rssBytes: 12_288,
    });
  });

  test("records failed bootstrap diagnostics without dropping server health", async () => {
    const snapshot = await collectDesktopDiagnostics({
      desktop: desktopSummary(),
      logs: { lineLimit: 1000, lines: 1 },
      serverConnection: {
        serverUrl: "http://127.0.0.1:17874",
        token: "server-capability-token",
      },
      now: () => Date.now(),
      fetchImpl: async (url) => {
        if (String(url).endsWith("/health")) {
          return Response.json({ ok: true, server: "openpond-app-server" });
        }
        return Response.json({ error: "bootstrap unavailable" }, { status: 503 });
      },
    });

    expect(snapshot.server.health?.ok).toBe(true);
    expect(snapshot.server.bootstrap).toMatchObject({
      ok: false,
      status: 503,
      error: "bootstrap unavailable",
    });
    expect(snapshot.server.store).toBeUndefined();
  });

  test(
    "collects real health and bootstrap diagnostics from an isolated local server",
    async () => {
      const storeDir = await mkdtemp(join(tmpdir(), "openpond-desktop-diagnostics-"));
      const server = await createOpenPondServer({
        port: 0,
        storeDir,
        silent: true,
        version: "diagnostics-test",
      });

      try {
        const snapshot = await collectDesktopDiagnostics({
          desktop: desktopSummary(),
          logs: { lineLimit: 1000, lines: 0 },
          serverConnection: {
            serverUrl: server.url,
            token: server.token,
          },
        });

        expect(snapshot.server.configured).toBe(true);
        expect(snapshot.server.health).toMatchObject({
          ok: true,
          status: 200,
        });
        expect(snapshot.server.health?.payload).toMatchObject({
          ok: true,
          server: "openpond-app-server",
          version: "diagnostics-test",
        });
      expect(snapshot.server.bootstrap?.ok).toBe(true);
      expect(snapshot.server.bootstrap?.status).toBe(200);
      expect(snapshot.server.bootstrap?.responseBytes).toBeGreaterThan(100);
      expect(snapshot.server.providers?.ok).toBe(true);
      expect(typeof snapshot.server.providers?.payload?.providerPayloadBytes).toBe("number");
      expect(typeof snapshot.server.providers?.payload?.modelCacheBytes).toBe("number");
      expect(typeof snapshot.server.providers?.payload?.modelCacheModelCount).toBe("number");
      expect(Array.isArray(snapshot.server.providers?.payload?.recentOperations)).toBe(true);
      expect(snapshot.server.store).toMatchObject({
          storePath: server.storePath,
          serverId: server.status.id,
          host: server.status.host,
          port: server.status.port,
          version: "diagnostics-test",
        });
        expect(JSON.stringify(snapshot)).not.toContain(server.token);
      } finally {
        await server.close();
        await rm(storeDir, { recursive: true, force: true });
      }
    },
    30_000
  );
});
