import { once } from "node:events";
import { spawn } from "node:child_process";
import type { ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { sha256 } from "../packages/taskset-sdk/src";
import {
  selectPortableModelArtifacts,
  streamTrainingArtifactPackage,
  trainingArtifactPackageSize,
} from "../apps/server/src/training/training-artifact-package";

describe("LoRA artifact package", () => {
  test("selects the final Fireworks artifacts from nested provider paths", () => {
    const artifact = (
      id: string,
      providerFilename: string,
      createdAt: string,
    ) => ({
      schemaVersion: "openpond.trainingArtifact.v1" as const,
      id,
      jobId: "job_nested",
      kind: providerFilename.endsWith(".safetensors")
        ? "adapter" as const
        : "manifest" as const,
      path: `/tmp/${id}`,
      sha256: "a".repeat(64),
      sizeBytes: 1,
      baseModelId: "accounts/fireworks/models/qwen3-8b",
      baseModelRevision: "provider-v1",
      tokenizerRevision: "provider-v1",
      chatTemplateHash: "chattemplatehash",
      nonProduction: false,
      createdAt,
      metadata: {
        provider: "fireworks",
        providerFilename,
      },
    });
    const selected = selectPortableModelArtifacts([
      artifact(
        "checkpoint_weights",
        "tuned/model/checkpoint/checkpoint/01-0000000/adapter_model.safetensors",
        "2026-07-17T20:01:00.000Z",
      ),
      artifact(
        "final_weights",
        "tuned/model/checkpoint/adapter_model.safetensors",
        "2026-07-17T20:00:00.000Z",
      ),
      artifact(
        "final_config",
        "tuned/model/checkpoint/adapter_config.json",
        "2026-07-17T20:00:00.000Z",
      ),
      artifact(
        "ignored_optimizer",
        "tuned/model/checkpoint/optimizer.pt",
        "2026-07-17T20:00:00.000Z",
      ),
    ]);

    expect(selected.map((entry) => ({
      id: entry.artifact.id,
      name: entry.name,
    }))).toEqual([
      { id: "final_config", name: "adapter_config.json" },
      { id: "final_weights", name: "adapter_model.safetensors" },
    ]);
  });

  test("selects a Fireworks sharded LoRA and its index", () => {
    const artifact = (
      id: string,
      providerFilename: string,
    ) => ({
      schemaVersion: "openpond.trainingArtifact.v1" as const,
      id,
      jobId: "job_sharded",
      kind: providerFilename.endsWith(".safetensors")
        ? "adapter" as const
        : "manifest" as const,
      path: `/tmp/${id}`,
      sha256: "a".repeat(64),
      sizeBytes: 1,
      baseModelId: "accounts/fireworks/models/qwen3-8b",
      baseModelRevision: "provider-v1",
      tokenizerRevision: "provider-v1",
      chatTemplateHash: "chattemplatehash",
      nonProduction: false,
      createdAt: "2026-07-18T06:38:26.000Z",
      metadata: {
        provider: "fireworks",
        providerFilename,
      },
    });
    const selected = selectPortableModelArtifacts([
      artifact("config", "model/adapter_config.json"),
      artifact(
        "weights",
        "model/adapter_model-00001-of-00001.safetensors",
      ),
      artifact("index", "model/adapter_model.safetensors.index.json"),
      artifact("ignored", "model/tokenizer.json"),
    ]);

    expect(selected.map((entry) => entry.name)).toEqual([
      "adapter_config.json",
      "adapter_model-00001-of-00001.safetensors",
      "adapter_model.safetensors.index.json",
    ]);
  });

  test("streams a valid deterministic USTAR containing manifest and weights", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "openpond-lora-package-"));
    try {
      const weights = Buffer.from("real-lora-weight-bytes");
      const weightsPath = path.join(directory, "adapter_model.safetensors");
      await writeFile(weightsPath, weights);
      const value = {
        filename: "model.openpond-lora.tar",
        manifest: Buffer.from("{\"schemaVersion\":\"openpond.modelPackage.v1\"}\n"),
        entries: [{
          name: "model/adapter_model.safetensors",
          artifact: {
            schemaVersion: "openpond.trainingArtifact.v1" as const,
            id: "artifact_weights",
            jobId: "job_weights",
            kind: "adapter" as const,
            path: weightsPath,
            sha256: sha256(weights),
            sizeBytes: weights.byteLength,
            baseModelId: "accounts/fireworks/models/qwen3-0p6b",
            baseModelRevision: "provider-v1",
            tokenizerRevision: "provider-v1",
            chatTemplateHash: "chattemplatehash",
            nonProduction: false,
            createdAt: "2026-07-17T20:00:00.000Z",
            metadata: {
              provider: "fireworks",
              providerFilename: "adapter_model.safetensors",
            },
          },
        }],
      };
      const output = new PassThrough();
      const chunks: Buffer[] = [];
      output.on("data", (chunk: Buffer) => chunks.push(chunk));
      const ended = once(output, "end");
      await streamTrainingArtifactPackage(
        output as unknown as ServerResponse,
        value,
      );
      await ended;
      const tar = Buffer.concat(chunks);

      expect(tar.byteLength).toBe(trainingArtifactPackageSize(value));
      expect(readTar(tar)).toEqual([
        {
          name: "openpond-model-manifest.json",
          bytes: value.manifest,
        },
        {
          name: "model/adapter_model.safetensors",
          bytes: weights,
        },
      ]);
      expect(await listWithSystemTar(tar)).toEqual([
        "openpond-model-manifest.json",
        "model/adapter_model.safetensors",
      ]);
      expect(tar.subarray(-1_024).equals(Buffer.alloc(1_024))).toBe(true);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

function readTar(tar: Buffer): Array<{ name: string; bytes: Buffer }> {
  const entries: Array<{ name: string; bytes: Buffer }> = [];
  let offset = 0;
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    if (header.equals(Buffer.alloc(512))) break;
    const name = header.subarray(0, 100).toString("utf8")
      .replace(/\0.*$/s, "");
    const sizeText = header.subarray(124, 136).toString("ascii")
      .replace(/\0.*$/s, "")
      .trim();
    const size = Number.parseInt(sizeText || "0", 8);
    const bytes = tar.subarray(offset + 512, offset + 512 + size);
    entries.push({ name, bytes: Buffer.from(bytes) });
    offset += 512 + size + ((512 - (size % 512)) % 512);
  }
  return entries;
}

async function listWithSystemTar(tar: Buffer): Promise<string[]> {
  const child = spawn("tar", ["-tf", "-"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdin.end(tar);
  const [code] = await once(child, "exit") as [number | null];
  if (code !== 0) {
    throw new Error(Buffer.concat(stderr).toString("utf8"));
  }
  return Buffer.concat(stdout).toString("utf8").trim().split("\n");
}
