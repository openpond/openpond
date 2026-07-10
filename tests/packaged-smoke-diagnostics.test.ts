import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  capturePackagedProcess,
  errorDetails,
  preservePackagedAppLogs,
} from "../scripts/packaged-smoke-diagnostics";

describe("packaged smoke diagnostics", () => {
  test("captures stdout, stderr, and the terminal process state", async () => {
    const child = spawn(process.execPath, ["-e", 'console.log("smoke-out"); console.error("smoke-err")'], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const capture = capturePackagedProcess(child);
    await once(child, "exit");

    expect(capture.snapshot()).toMatchObject({
      exitCode: 0,
      signalCode: null,
      spawnError: null,
    });
    expect(capture.snapshot().stdout).toContain("smoke-out");
    expect(capture.snapshot().stderr).toContain("smoke-err");
  });

  test("copies app logs beside the smoke report before temporary state is removed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openpond-packaged-diagnostics-"));
    try {
      const appHome = path.join(dir, "app-home");
      const reportPath = path.join(dir, "artifacts", "smoke-linux-x64-appimage.json");
      await mkdir(path.join(appHome, "logs"), { recursive: true });
      await writeFile(path.join(appHome, "logs", "desktop.log"), "startup failed\n");

      const result = await preservePackagedAppLogs({ appHome, reportPath });

      expect(result.copied).toBe(true);
      expect(result.error).toBeNull();
      expect(await readFile(path.join(
        dir,
        "artifacts",
        "smoke-linux-x64-appimage-logs",
        "desktop.log",
      ), "utf8")).toBe("startup failed\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("serializes non-error failures safely", () => {
    expect(errorDetails("failure")).toEqual({ message: "failure", stack: null });
  });
});
