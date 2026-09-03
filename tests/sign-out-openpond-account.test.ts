import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runTestProcess } from "./helpers/run-process";

let tempHome: string | null = null;

beforeEach(async () => {
  tempHome = await mkdtemp(path.join(os.tmpdir(), "openpond-account-logout-"));
});

afterEach(async () => {
  if (tempHome) await rm(tempHome, { recursive: true, force: true });
  tempHome = null;
});

test("logging out clears only the active account credentials", async () => {
  if (!tempHome) throw new Error("missing temp home");
  const configDir = path.join(tempHome, ".openpond");
  const configPath = path.join(configDir, "config.json");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({
      activeProfile: { handle: "active", baseUrl: "https://openpond.ai" },
      accounts: [
        {
          handle: "active",
          apiKey: "opk_active",
          token: "legacy-token",
          session: { token: "session-token", appId: "app-1" },
          baseUrl: "https://openpond.ai",
        },
        {
          handle: "other",
          apiKey: "opk_other",
          baseUrl: "https://staging.openpond.ai",
        },
      ],
    }),
    "utf8",
  );

  const script = `
    import { signOutOpenPondAccount } from "./packages/runtime/src/sign-out-account.ts";
    await signOutOpenPondAccount();
  `;
  const result = await runTestProcess(
    process.execPath,
    ["--import", "tsx", "-e", script],
    {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: {
        ...process.env,
        OPENPOND_CONFIG_DIR: configDir,
      },
    },
  );

  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  const saved = JSON.parse(await readFile(configPath, "utf8"));
  expect(saved.accounts[0]).toEqual({
    handle: "active",
    baseUrl: "https://openpond.ai",
  });
  expect(saved.accounts[1].apiKey).toBe("opk_other");
});
