import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { AGENT_PROTOCOL_VERSION } from "@openpond/agent-runtime";
import { afterEach, describe, expect, test } from "vitest";

const require = createRequire(import.meta.url);
const cleanupDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("openpond app-server process boundary", () => {
  test("starts through the public CLI and speaks clean JSONL without an HTTP listener", async () => {
    const storeDir = await mkdtemp(path.join(os.tmpdir(), "openpond-agent-cli-"));
    cleanupDirectories.push(storeDir);
    const startedAt = performance.now();
    const child = spawn(
      process.execPath,
      [
        require.resolve("tsx/cli"),
        path.resolve("apps/cli/src/cli/main.ts"),
        "app-server",
        "--store-dir",
        storeDir,
      ],
      {
        cwd: path.resolve("."),
        env: { ...process.env, OPENPOND_HARNESS_SCRIPTED_MODELS: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let startupMs: number | null = null;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (startupMs === null && stdout.includes("\n")) startupMs = performance.now() - startedAt;
    });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });

    for (const message of [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: AGENT_PROTOCOL_VERSION,
          client: { name: "cli-process-test", version: "1" },
        },
      },
      { jsonrpc: "2.0", method: "initialized" },
      { jsonrpc: "2.0", id: 2, method: "runtime/capabilities", params: {} },
      { jsonrpc: "2.0", id: 3, method: "harness/validate", params: {} },
    ]) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }
    child.stdin.end();

    const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
    expect({ code, signal, stderr }).toEqual({ code: 0, signal: null, stderr: "" });
    const messages = stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(messages).toHaveLength(3);
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 1,
        result: expect.objectContaining({ protocolVersion: AGENT_PROTOCOL_VERSION }),
      }),
      expect.objectContaining({
        id: 2,
        result: expect.objectContaining({ placement: "hosted_work" }),
      }),
      expect.objectContaining({
        id: 3,
        result: expect.objectContaining({ valid: true }),
      }),
    ]));
    expect(startupMs).not.toBeNull();
    expect(startupMs!).toBeLessThan(10_000);
    reportMetric("processStartupMs", startupMs!);
    expect(stdout).not.toContain("OPENPOND_APP_SERVER_READY");
    expect(stdout).not.toContain("OpenPond API server");
  }, 20_000);
});

function reportMetric(name: string, value: number): void {
  if (process.env.OPENPOND_REPORT_AGENT_METRICS === "1") {
    console.info(`OPENPOND_AGENT_METRIC ${JSON.stringify({ name, value: Math.round(value * 100) / 100 })}`);
  }
}
