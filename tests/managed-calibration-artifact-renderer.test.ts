import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";

import { renderManagedCalibrationArtifact } from "../apps/server/src/training/managed-calibration-artifact-renderer.js";
import type { SqliteStore } from "../apps/server/src/store/store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("managed calibration artifact renderer", () => {
  it("renders a structured layered selection inside the trusted Taskset workspace", async () => {
    const workspace = await temporaryWorkspace();
    await mkdir(path.join(workspace, "assets", "layers"), { recursive: true });
    await writeFile(
      path.join(workspace, "assets", "renderer.json"),
      JSON.stringify({
        kind: "reference_layered_artifact_files_v1",
        config: {
          schemaVersion: "openpond.referenceLayeredArtifactFiles.v1",
          catalogRef: "assets/catalog.json",
          assetRoot: "assets",
          outputMediaType: "image/png",
        },
      }),
    );
    await writeFile(
      path.join(workspace, "assets", "catalog.json"),
      JSON.stringify({
        schemaVersion: "openpond.layeredArtifactCatalog.v1",
        width: 2,
        height: 1,
        layers: [
          { id: "background", variants: [{ id: "background-red", file: "layers/red.png" }] },
          { id: "overlay", variants: [{ id: "overlay-blue", file: "layers/blue.png" }] },
        ],
      }),
    );
    await writeFile(
      path.join(workspace, "assets", "layers", "red.png"),
      png(2, 1, [255, 0, 0, 255, 255, 0, 0, 255]),
    );
    await writeFile(
      path.join(workspace, "assets", "layers", "blue.png"),
      png(2, 1, [0, 0, 255, 128, 0, 0, 0, 0]),
    );

    const rendered = await renderManagedCalibrationArtifact({
      store: storeFor(workspace),
      tasksetId: "taskset-quality",
      task: { expectedOutput: { artifactRendererRef: "renderer-config" } },
      environment: {
        resources: [
          {
            id: "renderer-config",
            path: "assets/renderer.json",
            visibility: "privileged",
          },
        ],
      },
      output: JSON.stringify({
        traits: { background: "background-red", overlay: "overlay-blue" },
      }),
    });

    expect(rendered?.mediaType).toBe("image/png");
    const image = PNG.sync.read(rendered!.bytes);
    expect([...image.data.subarray(0, 4)]).toEqual([127, 0, 128, 255]);
    expect([...image.data.subarray(4, 8)]).toEqual([255, 0, 0, 255]);
  });

  it("rejects renderer resources that escape the Taskset workspace", async () => {
    const parent = await temporaryWorkspace();
    const workspace = path.join(parent, "workspace");
    await mkdir(workspace);
    await writeFile(path.join(parent, "outside.json"), "{}");

    await expect(
      renderManagedCalibrationArtifact({
        store: storeFor(workspace),
        tasksetId: "taskset-quality",
        task: { expectedOutput: { artifactRendererRef: "renderer-config" } },
        environment: {
          resources: [
            {
              id: "renderer-config",
              path: "../outside.json",
              visibility: "privileged",
            },
          ],
        },
        output: JSON.stringify({ traits: {} }),
      }),
    ).rejects.toThrow("escaped its Taskset workspace");
  });
});

function storeFor(workspacePath: string): SqliteStore {
  return {
    getTasksetDraftWorkspace: async () => ({
      draftId: "taskset-quality",
      workspacePath,
      packageHash: "a".repeat(64),
    }),
  } as unknown as SqliteStore;
}

async function temporaryWorkspace(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "openpond-calibration-renderer-"));
  temporaryDirectories.push(directory);
  return directory;
}

function png(width: number, height: number, rgba: number[]): Buffer {
  const image = new PNG({ width, height });
  image.data.set(rgba);
  return PNG.sync.write(image);
}
