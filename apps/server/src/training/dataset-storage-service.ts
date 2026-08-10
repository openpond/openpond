import { constants } from "node:fs";
import { access, mkdir, readFile, rename, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DatasetStorageSettingsSchema,
  DatasetStorageStateSchema,
  UpdateDatasetStorageSettingsRequestSchema,
  type DatasetStorageSettings,
} from "@openpond/contracts";
import { discoverStorageCandidates, storageKindForPath } from "./dataset-storage-discovery.js";
import { runCommandProbe } from "./dataset-storage-probe.js";

export function createDatasetStorageService(input: { storeDir: string }) {
  const directory = path.join(input.storeDir, "datasets");
  const settingsPath = path.join(directory, "settings.json");

  async function settings(): Promise<DatasetStorageSettings> {
    try {
      return DatasetStorageSettingsSchema.parse(JSON.parse(await readFile(settingsPath, "utf8")));
    } catch {
      return DatasetStorageSettingsSchema.parse({
        schemaVersion: "openpond.datasetStorageSettings.v1",
        datasetStorePath: path.join(input.storeDir, "datasets"),
        updatedAt: new Date().toISOString(),
      });
    }
  }

  async function state() {
    const current = await settings();
    const candidates = await discoverStorageCandidates({
      commandProbe: runCommandProbe,
      platform: process.platform,
      storeDir: input.storeDir,
    });
    if (!candidates.some((candidate) => path.resolve(candidate.datasetStorePath) === path.resolve(current.datasetStorePath))) {
      candidates.push({
        datasetStorePath: current.datasetStorePath,
        kind: storageKindForPath(current.datasetStorePath),
        label: "Configured location",
        modelStorePath: current.datasetStorePath,
        path: current.datasetStorePath,
      });
    }
    const storageRoots = await Promise.all(candidates.map(async (candidate) => {
      const writable = await ensureWritable(candidate.datasetStorePath);
      const stats = await statfs(candidate.path).catch(() => null);
      return {
        ...candidate,
        freeBytes: stats ? Number(stats.bavail) * Number(stats.bsize) : null,
        totalBytes: stats ? Number(stats.blocks) * Number(stats.bsize) : null,
        writable,
      };
    }));
    return DatasetStorageStateSchema.parse({
      schemaVersion: "openpond.datasetStorageState.v1",
      settings: current,
      storageRoots,
    });
  }

  async function update(value: unknown) {
    const request = UpdateDatasetStorageSettingsRequestSchema.parse(value);
    const updated = DatasetStorageSettingsSchema.parse({
      schemaVersion: "openpond.datasetStorageSettings.v1",
      datasetStorePath: path.resolve(request.datasetStorePath),
      updatedAt: new Date().toISOString(),
    });
    if (!await ensureWritable(updated.datasetStorePath)) {
      throw new Error("Dataset storage folder is not writable.");
    }
    await mkdir(directory, { recursive: true });
    const temporaryPath = `${settingsPath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
    await rename(temporaryPath, settingsPath);
    return state();
  }

  return { settings, state, update };
}

async function ensureWritable(value: string): Promise<boolean> {
  try {
    await mkdir(value, { recursive: true });
    await access(value, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
