import { readAccountConfiguration } from "../packages/persistence/src/accounts";
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
    previousConfigDir = process.env.OPENPOND_HOME;
    home = await mkdtemp(path.join(tmpdir(), "openpond-private-persistence-"));
    process.env.HOME = home;
    process.env.OPENPOND_HOME = path.join(home, ".openpond");
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousConfigDir === undefined) delete process.env.OPENPOND_HOME;
    else process.env.OPENPOND_HOME = previousConfigDir;
    await rm(home, { recursive: true, force: true });
  });

  test("hashes credential cache partitions and preserves concurrent buckets", async () => {
    const apiKey = "opk_super_secret_cache_key_123456";
    await Promise.all([
      setCachedApps({ apiBase: "https://api.example.test", apiKey, apps: [] }),
      setCachedTools({ apiBase: "https://api.example.test", apiKey, tools: [{ id: "tool-1" }] }),
    ]);

    const cachePath = path.join(home, ".openpond", "cache", "cache.sqlite");
    const raw = (await readFile(cachePath)).toString("utf8");
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
    const configPath = path.join(home, ".openpond", "config.toml");
    const saved = await readAccountConfiguration(path.dirname(configPath));
    expect(await readFile(configPath, "utf8")).not.toContain("opk_private_config");
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
      saveGlobalConfig({ executionMode: "local" }),
    ]);

    await expect(loadGlobalConfig()).resolves.toMatchObject({
      lspEnabled: true,
      mode: "builder",
      executionMode: "local",
    });
    expect((await readdir(path.join(home, ".openpond"), { recursive: true })).filter((name) => /\.(lock|tmp)$/.test(name))).toEqual([]);
  });

  test("distinguishes malformed config from an absent config", async () => {
    await expect(loadGlobalConfig()).resolves.toMatchObject({ accounts: [{ handle: "default" }] });
    const configPath = path.join(home, ".openpond", "config.toml");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, "schema_version = [", "utf8");
    await expect(loadGlobalConfig()).rejects.toThrow("Configuration contains invalid TOML");
  });
});
