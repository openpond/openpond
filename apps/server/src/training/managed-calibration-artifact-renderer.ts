import path from "node:path";
import { readFile, realpath } from "node:fs/promises";

import { PNG } from "pngjs";
import { z } from "zod";

import type { SqliteStore } from "../store/store.js";

const RendererConfigSchema = z
  .object({
    kind: z.literal("reference_layered_artifact_files_v1"),
    config: z
      .object({
        schemaVersion: z.literal("openpond.referenceLayeredArtifactFiles.v1"),
        catalogRef: z.string().trim().min(1).max(1_000),
        assetRoot: z.string().trim().min(1).max(1_000),
        outputMediaType: z.literal("image/png"),
      })
      .strict(),
  })
  .strict();

const CatalogSchema = z
  .object({
    schemaVersion: z.literal("openpond.layeredArtifactCatalog.v1"),
    width: z.number().int().positive().max(2_048),
    height: z.number().int().positive().max(2_048),
    layers: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(191),
            variants: z
              .array(
                z
                  .object({
                    id: z.string().trim().min(1).max(191),
                    file: z.string().trim().min(1).max(1_000),
                  })
                  .passthrough(),
              )
              .min(1)
              .max(10_000),
          })
          .passthrough(),
      )
      .min(1)
      .max(100),
  })
  .passthrough();

const CandidateOutputSchema = z
  .object({
    traits: z.record(z.string(), z.string().trim().min(1).max(191)),
  })
  .strict();

export type ManagedCalibrationRenderedArtifact = {
  bytes: Buffer;
  mediaType: "image/png";
  rendererResourceId: string;
  rendererConfigPath: string;
};

export async function renderManagedCalibrationArtifact(input: {
  store: SqliteStore;
  tasksetId: string;
  task: {
    expectedOutput?: Record<string, unknown> | null;
  };
  environment: {
    resources?: ReadonlyArray<{
      id: string;
      path: string;
      visibility: string;
    }>;
  };
  output: string;
}): Promise<ManagedCalibrationRenderedArtifact | null> {
  const rendererResourceId = stringValue(input.task.expectedOutput?.artifactRendererRef);
  if (!rendererResourceId) return null;
  const resource = (input.environment.resources ?? []).find(
    (candidate) => candidate.id === rendererResourceId,
  );
  if (!resource || resource.visibility !== "privileged") {
    throw new Error("Managed calibration renderer must resolve to a privileged Taskset resource.");
  }
  const workspace = await input.store.getTasksetDraftWorkspace(input.tasksetId);
  if (!workspace) {
    throw new Error("Managed calibration renderer workspace was not found.");
  }
  const workspaceRoot = await realpath(workspace.workspacePath);
  const rendererConfigPath = await containedFile(workspaceRoot, resource.path);
  const renderer = RendererConfigSchema.parse(
    JSON.parse(await readUtf8(rendererConfigPath, 1_000_000)),
  );
  const catalogPath = await containedFile(workspaceRoot, renderer.config.catalogRef);
  const catalog = CatalogSchema.parse(
    JSON.parse(await readUtf8(catalogPath, 5_000_000)),
  );
  const candidate = CandidateOutputSchema.parse(JSON.parse(input.output));
  const traitKeys = Object.keys(candidate.traits).sort();
  const layerKeys = catalog.layers.map((layer) => layer.id).sort();
  if (traitKeys.length !== layerKeys.length || traitKeys.some((key, index) => key !== layerKeys[index])) {
    throw new Error("Managed calibration candidate traits do not match the renderer catalog layers.");
  }

  const result = new PNG({ width: catalog.width, height: catalog.height, fill: true });
  result.data.fill(0);
  for (const layer of catalog.layers) {
    const selectedId = candidate.traits[layer.id]!;
    const selected = layer.variants.find((variant) => variant.id === selectedId);
    if (!selected) {
      throw new Error(`Managed calibration renderer could not resolve ${layer.id}:${selectedId}.`);
    }
    const assetPath = await containedFile(
      workspaceRoot,
      path.posix.join(renderer.config.assetRoot, selected.file),
    );
    const layerBytes = await readBounded(assetPath, 25_000_000);
    const layerImage = PNG.sync.read(layerBytes, { checkCRC: true });
    if (layerImage.width !== catalog.width || layerImage.height !== catalog.height) {
      throw new Error(`Managed calibration renderer asset ${selected.id} has the wrong dimensions.`);
    }
    compositeOver(result.data, layerImage.data);
  }
  return {
    bytes: PNG.sync.write(result, { colorType: 6, inputColorType: 6 }),
    mediaType: "image/png",
    rendererResourceId,
    rendererConfigPath: resource.path,
  };
}

function compositeOver(destination: Buffer, source: Buffer): void {
  if (destination.length !== source.length || destination.length % 4 !== 0) {
    throw new Error("Managed calibration renderer received incompatible RGBA buffers.");
  }
  for (let offset = 0; offset < source.length; offset += 4) {
    const sourceAlpha = source[offset + 3]! / 255;
    if (sourceAlpha === 0) continue;
    const destinationAlpha = destination[offset + 3]! / 255;
    const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
    for (let channel = 0; channel < 3; channel += 1) {
      const color =
        (source[offset + channel]! * sourceAlpha
          + destination[offset + channel]! * destinationAlpha * (1 - sourceAlpha))
        / outputAlpha;
      destination[offset + channel] = Math.round(color);
    }
    destination[offset + 3] = Math.round(outputAlpha * 255);
  }
}

async function containedFile(root: string, relativePath: string): Promise<string> {
  if (path.isAbsolute(relativePath)) {
    throw new Error("Managed calibration renderer paths must be workspace-relative.");
  }
  const candidate = await realpath(path.resolve(root, relativePath));
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error("Managed calibration renderer path escaped its Taskset workspace.");
  }
  return candidate;
}

async function readUtf8(filePath: string, maximumBytes: number): Promise<string> {
  return (await readBounded(filePath, maximumBytes)).toString("utf8");
}

async function readBounded(filePath: string, maximumBytes: number): Promise<Buffer> {
  const bytes = await readFile(filePath);
  if (bytes.byteLength > maximumBytes) {
    throw new Error("Managed calibration renderer resource exceeds its byte limit.");
  }
  return bytes;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
