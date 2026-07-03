import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let tempHome: string | null = null;

beforeEach(async () => {
  tempHome = await mkdtemp(path.join(os.tmpdir(), "openpond-account-config-"));
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

describe("updateOpenPondAccountConfig", () => {
  test("updates endpoint metadata without replacing the saved API key", async () => {
    const configPath = await writeConfig({
      goalStorageLocation: "workspace",
      activeProfile: { handle: "qa", baseUrl: "https://old-web.example" },
      accounts: [
        {
          handle: "qa",
          apiKey: "opk_existing_secret",
          baseUrl: "https://old-web.example",
          apiBaseUrl: "https://old-api.example",
          chatApiBaseUrl: "https://old-chat.example",
          environment: "production",
        },
      ],
    });

    const script = `
      import { updateOpenPondAccountConfig } from "./packages/runtime/src/update-account-config.ts";
      const context = await updateOpenPondAccountConfig({
        handle: "qa",
        currentBaseUrl: "https://old-web.example",
        baseUrl: "https://new-web.example",
        apiBaseUrl: "https://new-api.example",
        chatApiBaseUrl: null,
        environment: "staging",
      });
      console.log(JSON.stringify({
        apiBaseUrl: context.apiBaseUrl,
        chatApiBaseUrl: context.chatApiBaseUrl,
        apiKey: context.account?.apiKey ?? null,
      }));
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: path.resolve(import.meta.dir, ".."),
      env: { ...process.env, HOME: tempHome! },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const context = JSON.parse(stdout);
    const saved = JSON.parse(await readFile(configPath, "utf8"));

    expect(saved.goalStorageLocation).toBe("workspace");
    expect(saved.activeProfile).toEqual({ handle: "qa", baseUrl: "https://new-web.example" });
    expect(saved.accounts).toEqual([
      {
        handle: "qa",
        apiKey: "opk_existing_secret",
        baseUrl: "https://new-web.example",
        apiBaseUrl: "https://new-api.example",
        environment: "staging",
      },
    ]);
    expect(context.apiKey).toBe("opk_existing_secret");
    expect(context.apiBaseUrl).toBe("https://new-api.example");
    expect(context.chatApiBaseUrl).toBe("https://new-api.example/opchat/v1");
  });
});
