import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { copyTreePortable } from "../apps/server/src/training/portable-file-copy";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })),
  );
});

describe("portable artifact copy", () => {
  test("falls back to streamed copies when a destination rejects copyfile", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openpond-portable-copy-"));
    temporaryDirectories.push(root);
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    await mkdir(path.join(source, "adapter"), { recursive: true });
    await writeFile(path.join(source, "adapter", "README.md"), "portable artifact\n");
    await writeFile(path.join(source, "manifest.json"), "{\"verified\":true}\n");

    await copyTreePortable(source, destination, async () => {
      throw Object.assign(new Error("copyfile unsupported"), { code: "ENOTSUP" });
    });

    await expect(readFile(path.join(destination, "adapter", "README.md"), "utf8"))
      .resolves.toBe("portable artifact\n");
    await expect(readFile(path.join(destination, "manifest.json"), "utf8"))
      .resolves.toBe("{\"verified\":true}\n");
  });
});
