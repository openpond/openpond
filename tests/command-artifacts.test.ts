import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { discoverCommandArtifacts } from "../apps/server/src/openpond/command-artifacts";

describe("command artifact discovery", () => {
  test("persists existing media paths reported by a successful command", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openpond-command-artifacts-"));
    try {
      const videoPath = path.join(root, "demo branded.mp4");
      const imagePath = path.join(root, "contact-sheet.png");
      await writeFile(videoPath, Buffer.from("video"));
      await writeFile(imagePath, Buffer.from("image"));

      const artifacts = await discoverCommandArtifacts({
        cwd: root,
        stdout: `Updated file: ${videoPath}\n{"outputPath":"contact-sheet.png"}`,
        stderr: "",
      });

      expect(artifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: videoPath, contentType: "video/mp4", sizeBytes: 5 }),
        expect.objectContaining({ path: imagePath, contentType: "image/png", sizeBytes: 5 }),
      ]));
      expect(artifacts).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("ignores output paths that do not exist", async () => {
    await expect(discoverCommandArtifacts({
      cwd: "/tmp",
      stdout: "Updated file: /tmp/openpond-missing-output.mp4",
      stderr: "",
    })).resolves.toEqual([]);
  });

  test("keeps diagnostic file mentions in stderr out of deliverable artifacts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openpond-command-artifacts-"));
    try {
      const sourcePath = path.join(root, "source.mp4");
      await writeFile(sourcePath, Buffer.from("source"));

      await expect(discoverCommandArtifacts({
        cwd: root,
        stdout: "",
        stderr: `Input #0, mov,mp4, from '${sourcePath}':`,
      })).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

});
