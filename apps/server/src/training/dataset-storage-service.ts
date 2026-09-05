import { constants } from "node:fs";
import { access, mkdir, statfs } from "node:fs/promises";
import path from "node:path";
import { readConfig, updateConfig, resolveConfigPath } from "@openpond/persistence";
import {
  DatasetStorageSettingsSchema,
  DatasetStorageStateSchema,
  UpdateDatasetStorageSettingsRequestSchema,
  type DatasetStorageSettings,
} from "@openpond/contracts";
import { discoverStorageCandidates, storageKindForPath } from "./dataset-storage-discovery.js";
import { runCommandProbe } from "./dataset-storage-probe.js";

export function createDatasetStorageService(input: { storeDir: string }) {
  async function settings(): Promise<DatasetStorageSettings> {
    const { document } = await readConfig(input.storeDir);
    return DatasetStorageSettingsSchema.parse({
      schemaVersion: "openpond.datasetStorageSettings.v1",
      datasetStorePath: resolveConfigPath(document.storage?.datasets_dir ?? "datasets", input.storeDir),
      updatedAt: "1970-01-01T00:00:00.000Z",
    });
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
        path: current.datasetStorePath,
      });
    }
    const storageRoots = await Promise.all(candidates.map(async (candidate) => {
      const writable = await access(candidate.datasetStorePath, constants.W_OK).then(() => true, () => false);
      const stats = await statfs(candidate.path).catch(() => null);
      return {
        ...candidate,
        id: `dataset-storage-${Buffer.from(candidate.path).toString("base64url").slice(0, 120)}`,
        configured: path.resolve(candidate.datasetStorePath) === path.resolve(current.datasetStorePath),
        mounted: stats !== null,
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
    await updateConfig(input.storeDir, (document) => ({ ...document, storage: { ...document.storage, datasets_dir: updated.datasetStorePath } }));
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
