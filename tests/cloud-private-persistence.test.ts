import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  getCachedApps,
  getCachedTools,
  setCachedApps,
  setCachedTools,
} from "../packages/cloud/src/cache";
import { loadGlobalConfig, saveGlobalConfig } from "../packages/cloud/src/config";

describe("private cloud persistence", () => {
  let home = "";
  let previousHome: string | undefined;
  let previousConfigDir: string | undefined;

  beforeEach(async () => {
    previousHome = process.env.HOME;
    previousConfigDir = process.env.OPENPOND_CONFIG_DIR;
    home = await mkdtemp(path.join(tmpdir(), "openpond-private-persistence-"));
    process.env.HOME = home;
    process.env.OPENPOND_CONFIG_DIR = path.join(home, ".openpond");
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousConfigDir === undefined) delete process.env.OPENPOND_CONFIG_DIR;
    else process.env.OPENPOND_CONFIG_DIR = previousConfigDir;
    await rm(home, { recursive: true, force: true });
  });

  test("hashes credential cache partitions and preserves concurrent buckets", async () => {
    const apiKey = "opk_super_secret_cache_key_123456";
    await Promise.all([
      setCachedApps({ apiBase: "https://api.example.test", apiKey, apps: [] }),
      setCachedTools({ apiBase: "https://api.example.test", apiKey, tools: [{ id: "tool-1" }] }),
    ]);

    const cachePath = path.join(home, ".openpond", "cache.json");
    const raw = await readFile(cachePath, "utf8");
    expect(raw).not.toContain(apiKey);
    expect(raw).not.toContain("opk_super");
    expect(await getCachedApps({ apiBase: "https://api.example.test", apiKey })).toEqual([]);
    expect(await getCachedTools({ apiBase: "https://api.example.test", apiKey })).toEqual([{ id: "tool-1" }]);
    if (process.platform !== "win32") {
      expect((await stat(path.dirname(cachePath))).mode & 0o777).toBe(0o700);
      expect((await stat(cachePath)).mode & 0o777).toBe(0o600);
    }
  });

  test("writes global config atomically with private permissions", async () => {
    await saveGlobalConfig({ apiKey: "opk_private_config", baseUrl: "https://example.test" });
    const configPath = path.join(home, ".openpond", "config.json");
    const saved = JSON.parse(await readFile(configPath, "utf8")) as {
      accounts?: Array<{ apiKey?: string }>;
    };
    expect(saved.accounts?.some((account) => account.apiKey === "opk_private_config")).toBe(true);
    if (process.platform !== "win32") {
      expect((await stat(path.dirname(configPath))).mode & 0o777).toBe(0o700);
      expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    }
  });

  test("serializes concurrent config transactions without leaving lock or temp files", async () => {
    await Promise.all([
      saveGlobalConfig({ lspEnabled: true }),
      saveGlobalConfig({ mode: "builder" }),
      saveGlobalConfig({ goalStorageLocation: "workspace" }),
    ]);

    await expect(loadGlobalConfig()).resolves.toMatchObject({
      lspEnabled: true,
      mode: "builder",
      goalStorageLocation: "workspace",
    });
    expect(await readdir(path.join(home, ".openpond"))).toEqual(["config.json"]);
  });

  test("distinguishes malformed config from an absent config", async () => {
    await expect(loadGlobalConfig()).resolves.toMatchObject({ accounts: [{ handle: "default" }] });
    const configPath = path.join(home, ".openpond", "config.json");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, "{not-json", "utf8");
    await expect(loadGlobalConfig()).rejects.toThrow("config is malformed JSON");
  });
});
