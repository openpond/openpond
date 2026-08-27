import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runTestProcess } from "./helpers/run-process";

let tempHome: string | null = null;

beforeEach(async () => {
  tempHome = await mkdtemp(path.join(os.tmpdir(), "openpond-account-remove-"));
});

afterEach(async () => {
  if (tempHome) await rm(tempHome, { recursive: true, force: true });
  tempHome = null;
});

async function writeConfig(value: unknown): Promise<string> {
  if (!tempHome) throw new Error("missing temp home");
  const configDir = path.join(tempHome, ".openpond");
  const configPath = path.join(configDir, "config.json");
  await mkdir(configDir, { recursive: true });
  await writeFile(configPath, JSON.stringify(value, null, 2), "utf8");
  return configPath;
}

async function runRemove(
  handle: string,
  baseUrl: string
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const script = `
    import { removeOpenPondAccount } from "./packages/runtime/src/remove-account.ts";
    await removeOpenPondAccount(${JSON.stringify({ handle, baseUrl })});
    console.log("removed");
  `;
  return runTestProcess(process.execPath, ["--import", "tsx", "-e", script], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      OPENPOND_CONFIG_DIR: path.join(tempHome!, ".openpond"),
    },
  });
}

describe("removeOpenPondAccount", () => {
  test("removes one inactive saved account without changing the active account", async () => {
    const configPath = await writeConfig({
      activeProfile: {
        handle: "active",
        baseUrl: "https://openpond.ai",
      },
      accounts: [
        {
          handle: "active",
          apiKey: "opk_active",
          baseUrl: "https://openpond.ai",
        },
        {
          handle: "stale",
          apiKey: "opk_stale",
          baseUrl: "https://openpond.ai",
        },
      ],
    });

    const result = await runRemove("stale", "https://openpond.ai");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("removed");

    const saved = JSON.parse(await readFile(configPath, "utf8"));
    expect(saved.activeProfile).toEqual({
      handle: "active",
      baseUrl: "https://openpond.ai",
    });
    expect(saved.accounts).toEqual([
      {
        handle: "active",
        apiKey: "opk_active",
        baseUrl: "https://openpond.ai",
      },
    ]);
  });

  test("refuses to remove the active account", async () => {
    const configPath = await writeConfig({
      activeProfile: {
        handle: "active",
        baseUrl: "https://openpond.ai",
      },
      accounts: [
        {
          handle: "active",
          apiKey: "opk_active",
          baseUrl: "https://openpond.ai",
        },
      ],
    });

    const result = await runRemove("active", "https://openpond.ai");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(
      "Switch to another OpenPond account before removing the active account."
    );

    const saved = JSON.parse(await readFile(configPath, "utf8"));
    expect(saved.accounts).toHaveLength(1);
  });
});
