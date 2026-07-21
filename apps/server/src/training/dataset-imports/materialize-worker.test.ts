import { createHash } from "node:crypto";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  assertDatasetStorageCapacity,
  downloadDatasetFile,
  installVerifiedDatasetBlob,
  requiredDatasetStorageBytes,
  verifyDatasetFile,
} from "./materialize-worker.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })),
  );
});

describe("Dataset materialization file bounds", () => {
  test("downloads and hashes a file only when the inspected size matches", async () => {
    const directory = await temporaryDirectory();
    const destination = path.join(directory, "source.parquet.partial");
    const body = new TextEncoder().encode("verified parquet bytes");
    const onProgress = vi.fn(async () => undefined);

    const result = await downloadDatasetFile({
      request: requestReturning(body, body.byteLength),
      url: "https://huggingface.co/datasets/org/data/resolve/revision/file.parquet",
      destination,
      expectedSizeBytes: body.byteLength,
      signal: new AbortController().signal,
      onProgress,
    });

    expect(result).toEqual({
      contentHash: createHash("sha256").update(body).digest("hex"),
      sizeBytes: body.byteLength,
    });
    expect(onProgress).toHaveBeenCalledWith(body.byteLength);
    await expect(access(destination)).resolves.toBeUndefined();
  });

  test("rejects a mismatched Content-Length before creating a partial file", async () => {
    const directory = await temporaryDirectory();
    const destination = path.join(directory, "source.parquet.partial");

    await expect(downloadDatasetFile({
      request: requestReturning(new Uint8Array([1, 2, 3]), 3),
      url: "https://huggingface.co/datasets/org/data/resolve/revision/file.parquet",
      destination,
      expectedSizeBytes: 4,
      signal: new AbortController().signal,
      onProgress: async () => undefined,
    })).rejects.toThrow("response declared 3");
    await expect(access(destination)).rejects.toThrow();
  });

  test("stops an oversized stream and deletes its partial file", async () => {
    const directory = await temporaryDirectory();
    const destination = path.join(directory, "source.parquet.partial");

    await expect(downloadDatasetFile({
      request: requestReturning(new Uint8Array([1, 2, 3, 4, 5]), null),
      url: "https://huggingface.co/datasets/org/data/resolve/revision/file.parquet",
      destination,
      expectedSizeBytes: 4,
      signal: new AbortController().signal,
      onProgress: async () => undefined,
    })).rejects.toThrow("exceeded its inspected size");
    await expect(access(destination)).rejects.toThrow();
  });

  test("rejects a truncated stream and deletes its partial file", async () => {
    const directory = await temporaryDirectory();
    const destination = path.join(directory, "source.parquet.partial");

    await expect(downloadDatasetFile({
      request: requestReturning(new Uint8Array([1, 2, 3]), null),
      url: "https://huggingface.co/datasets/org/data/resolve/revision/file.parquet",
      destination,
      expectedSizeBytes: 4,
      signal: new AbortController().signal,
      onProgress: async () => undefined,
    })).rejects.toThrow("downloaded 3");
    await expect(access(destination)).rejects.toThrow();
  });

  test("deletes a partial file when cancellation interrupts a stream", async () => {
    const directory = await temporaryDirectory();
    const destination = path.join(directory, "source.parquet.partial");
    const controller = new AbortController();
    const firstChunk = new Uint8Array(4 * 1024 * 1024);
    const response = new Response(new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(firstChunk);
        stream.enqueue(new Uint8Array([1]));
        stream.close();
      },
    }));

    await expect(downloadDatasetFile({
      request: vi.fn(async () => response) as unknown as typeof fetch,
      url: "https://huggingface.co/datasets/org/data/resolve/revision/file.parquet",
      destination,
      expectedSizeBytes: firstChunk.byteLength + 1,
      signal: controller.signal,
      onProgress: async () => controller.abort(),
    })).rejects.toThrow("cancelled");
    await expect(access(destination)).rejects.toThrow();
  });

  test("requires source sizes and reserves transformation overhead", async () => {
    const directory = await temporaryDirectory();
    await expect(
      assertDatasetStorageCapacity(directory, [{ sizeBytes: null }]),
    ).rejects.toThrow("must declare its size");
    expect(requiredDatasetStorageBytes(100)).toBe(
      Math.ceil(100 * 2.2) + 256 * 1024 * 1024,
    );
    expect(() => requiredDatasetStorageBytes(-1)).toThrow(
      "non-negative integer",
    );
  });

  test("reuses a source blob only after verifying both size and SHA-256", async () => {
    const directory = await temporaryDirectory();
    const source = path.join(directory, "source.parquet");
    const body = new TextEncoder().encode("previously verified parquet");
    const contentHash = createHash("sha256").update(body).digest("hex");
    await writeFile(source, body);

    await expect(verifyDatasetFile({
      path: source,
      expectedSizeBytes: body.byteLength,
      expectedContentHash: contentHash,
    })).resolves.toBe(true);
    await expect(verifyDatasetFile({
      path: source,
      expectedSizeBytes: body.byteLength + 1,
      expectedContentHash: contentHash,
    })).resolves.toBe(false);
    await expect(verifyDatasetFile({
      path: source,
      expectedSizeBytes: body.byteLength,
      expectedContentHash: "0".repeat(64),
    })).resolves.toBe(false);
  });

  test("replaces a corrupted content-addressed blob with the verified download", async () => {
    const directory = await temporaryDirectory();
    const temporaryPath = path.join(directory, "download.partial");
    const blobPath = path.join(directory, "blob.parquet");
    const verified = new TextEncoder().encode("verified parquet bytes");
    const contentHash = createHash("sha256").update(verified).digest("hex");
    await writeFile(temporaryPath, verified);
    await writeFile(blobPath, "corrupted");

    await installVerifiedDatasetBlob({
      temporaryPath,
      blobPath,
      expectedSizeBytes: verified.byteLength,
      expectedContentHash: contentHash,
    });

    await expect(verifyDatasetFile({
      path: blobPath,
      expectedSizeBytes: verified.byteLength,
      expectedContentHash: contentHash,
    })).resolves.toBe(true);
    await expect(access(temporaryPath)).rejects.toThrow();
  });
});

function requestReturning(
  body: Uint8Array,
  contentLength: number | null,
): typeof fetch {
  return vi.fn(async () => new Response(body as unknown as BodyInit, {
    headers: contentLength === null
      ? undefined
      : { "content-length": String(contentLength) },
  })) as unknown as typeof fetch;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "openpond-dataset-"));
  temporaryDirectories.push(directory);
  return directory;
}
