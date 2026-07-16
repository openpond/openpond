import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { streamVoiceModelResponseToFile } from "../apps/server/src/voice-transcription";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("voice model download streaming", () => {
  test("streams chunks to a private file without buffering the response", async () => {
    const targetPath = await tempFile("model.bin");
    const response = chunkedResponse(["abc", "def"]);
    const sizeBytes = await streamVoiceModelResponseToFile({
      response,
      targetPath,
      signal: new AbortController().signal,
      minBytes: 1,
      maxBytes: 10,
    });

    expect(sizeBytes).toBe(6);
    expect(await readFile(targetPath, "utf8")).toBe("abcdef");
    expect((await stat(targetPath)).mode & 0o777).toBe(0o600);
  });

  test("cancels oversized or aborted downloads and removes the partial file", async () => {
    const oversizedPath = await tempFile("oversized.bin");
    await expect(streamVoiceModelResponseToFile({
      response: chunkedResponse(["123", "456"]),
      targetPath: oversizedPath,
      signal: new AbortController().signal,
      minBytes: 1,
      maxBytes: 5,
    })).rejects.toThrow("byte limit");
    await expect(stat(oversizedPath)).rejects.toMatchObject({ code: "ENOENT" });

    const cancelledPath = await tempFile("cancelled.bin");
    const controller = new AbortController();
    controller.abort();
    await expect(streamVoiceModelResponseToFile({
      response: chunkedResponse(["123"]),
      targetPath: cancelledPath,
      signal: controller.signal,
      minBytes: 1,
      maxBytes: 5,
    })).rejects.toThrow("cancelled");
    await expect(stat(cancelledPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function tempFile(name: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "openpond-voice-model-"));
  tempDirs.push(directory);
  return path.join(directory, name);
}

function chunkedResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }));
}
