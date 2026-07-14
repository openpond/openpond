import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import { createLogger } from "@openpond/logging";

type LoggerFactory = typeof createLogger;

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openpond-logger-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeSensitiveLog(createLogger: LoggerFactory): Promise<string> {
  return withTempDir(async (dir) => {
    const logger = createLogger({ channel: "redaction", logDir: dir });
    logger.info("loaded http://127.0.0.1:17876/#openpondToken=hash-secret&view=chat", {
      authorization: "Bearer header-secret",
      callbackUrl: "https://x-access-token:remote-secret@example.test/repo?api_key=query-secret&ok=1#token=hash-secret",
      nested: {
        terminalUrl: "wss://127.0.0.1:17874/v1/terminal?token=terminal-secret",
        error: new Error("failed with Bearer error-secret at https://example.test/callback?session_token=error-url-secret"),
      },
    });
    await logger.flush();
    return readFile(path.join(dir, "redaction.log"), "utf8");
  });
}

describe("logger redaction", () => {
  test("redacts URL credentials, token params, bearer values, and secret-key fields", async () => {
    const content = await writeSensitiveLog(createLogger);

    expect(content).toContain("[REDACTED]");
    expect(content).not.toContain("hash-secret");
    expect(content).not.toContain("header-secret");
    expect(content).not.toContain("remote-secret");
    expect(content).not.toContain("query-secret");
    expect(content).not.toContain("terminal-secret");
    expect(content).not.toContain("error-secret");
    expect(content).not.toContain("error-url-secret");
  });

  test("rotates logs after removing existing destinations", async () => {
    await withTempDir(async (dir) => {
      const logger = createLogger({
        channel: "rotate",
        logDir: dir,
        maxBytes: 180,
        maxFiles: 2,
      });
      await writeFile(path.join(dir, "rotate.log.1"), "preexisting destination", "utf8");

      logger.info("first", { payload: "x".repeat(180) });
      logger.info("second", { payload: "y".repeat(180) });
      await logger.flush();

      const files = (await readdir(dir)).sort();
      expect(files).toContain("rotate.log");
      expect(files).toContain("rotate.log.1");
      expect((await readFile(path.join(dir, "rotate.log.1"), "utf8"))).not.toContain("preexisting destination");
    });
  });
});
