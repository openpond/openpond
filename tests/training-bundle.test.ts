import { describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildTrainingBundle, createTrainingBundleExport, unpackTrainingBundleExport, validateTrainingBundle } from "../packages/training-sdk/src";
import { planFixture, tasksetFixture } from "./helpers/training-fixtures";

describe("Training Bundle", () => {
  test("exports only approved transformed demonstrations with inspectable hashes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "training-bundle-"));
    try {
      const taskset = tasksetFixture({ ready: true });
      const manifest = await buildTrainingBundle({ taskset, plan: planFixture(taskset), directory });
      expect(manifest).toMatchObject({ containsRawChats: false, containsSecrets: false, containsHiddenGraderAssets: false, excludedSourceIds: [] });
      const rows = (await readFile(path.join(directory, "data/train.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
      expect(rows).toEqual([{ id: "task_train", input: { prompt: "Say hello" }, expectedOutput: { text: "Hello friend" }, tags: ["fixture"] }]);
      expect(JSON.stringify(rows)).not.toContain("Source source_train");
      expect((await validateTrainingBundle(directory)).valid).toBe(true);
      const portable = await createTrainingBundleExport(directory);
      const unpacked = `${directory}-unpacked`;
      await unpackTrainingBundleExport(portable, unpacked);
      expect((await validateTrainingBundle(unpacked)).valid).toBe(true);
      expect(portable.files.every((file) => file.encoding === "base64" && file.content.length > 0)).toBe(true);
      await rm(unpacked, { recursive: true, force: true });
      await writeFile(path.join(directory, "data/train.jsonl"), "tampered\n");
      expect((await validateTrainingBundle(directory)).issues).toContain("data/train.jsonl: hash mismatch");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
