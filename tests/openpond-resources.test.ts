import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readLocalWorkspaceResource,
  searchLocalWorkspaceResources,
} from "../apps/server/src/openpond/resources";

async function tempWorkspace(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "openpond-resources-"));
}

describe("OpenPond resource read/search", () => {
  test("reads workspace file refs with content and truncation metadata", async () => {
    const repoPath = await tempWorkspace();
    await mkdir(path.join(repoPath, "src"), { recursive: true });
    await writeFile(path.join(repoPath, "src", "index.ts"), "export const answer = 42;\n");

    const result = await readLocalWorkspaceResource({
      repoPath,
      request: { ref: "workspace:file:src/index.ts" },
    });

    expect(result).toMatchObject({
      ref: "workspace:file:src/index.ts",
      kind: "workspace.file",
      title: "src/index.ts",
      contentType: "text/plain",
      truncation: { truncated: false },
    });
    expect(result.contentText).toContain("answer = 42");
    expect(result.metadata).toMatchObject({ path: "src/index.ts", binary: false });
    expect(result.relatedRefs).toContain("workspace:dir:src");
  });

  test("rejects resource refs that escape the workspace", async () => {
    const repoPath = await tempWorkspace();
    await writeFile(path.join(repoPath, "package.json"), "{}\n");

    await expect(
      readLocalWorkspaceResource({
        repoPath,
        request: { ref: "workspace:file:../package.json" },
      }),
    ).rejects.toThrow("Resource path");
  });

  test("does not follow symlinks outside the workspace", async () => {
    const repoPath = await tempWorkspace();
    const outsidePath = path.join(tmpdir(), `openpond-resource-outside-${Date.now()}.txt`);
    await writeFile(outsidePath, "outside\n");
    await symlink(outsidePath, path.join(repoPath, "outside.txt"));

    await expect(
      readLocalWorkspaceResource({
        repoPath,
        request: { ref: "workspace:file:outside.txt" },
      }),
    ).rejects.toThrow("workspace root");
  });

  test("lists directory resources and skips generated paths", async () => {
    const repoPath = await tempWorkspace();
    await mkdir(path.join(repoPath, "src"), { recursive: true });
    await mkdir(path.join(repoPath, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(repoPath, "src", "index.ts"), "console.log('ok');\n");
    await writeFile(path.join(repoPath, "node_modules", "pkg", "index.js"), "module.exports = {};\n");

    const result = await readLocalWorkspaceResource({
      repoPath,
      request: { ref: "workspace:dir:." },
    });

    expect(result.kind).toBe("workspace.dir");
    expect(result.contentText).toContain("dir src");
    expect(result.contentText).not.toContain("node_modules");
    expect(result.relatedRefs).toContain("workspace:dir:src");
  });

  test("returns metadata-only results for binary workspace files", async () => {
    const repoPath = await tempWorkspace();
    await writeFile(path.join(repoPath, "pixel.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));

    const result = await readLocalWorkspaceResource({
      repoPath,
      request: { ref: "workspace:file:pixel.png" },
    });

    expect(result.contentText).toBeUndefined();
    expect(result.contentType).toBe("image/png");
    expect(result.metadata).toMatchObject({ binary: true, path: "pixel.png" });
    expect(result.truncation.reason).toBe("binary");
  });

  test("searches workspace paths and text with stable refs", async () => {
    const repoPath = await tempWorkspace();
    await mkdir(path.join(repoPath, "src"), { recursive: true });
    await writeFile(path.join(repoPath, "src", "chat-renderer.ts"), "export const marker = 'inline image';\n");
    await writeFile(path.join(repoPath, "README.md"), "inline image docs\n");

    const result = await searchLocalWorkspaceResources({
      repoPath,
      request: { scope: "workspace", query: "inline image", limit: 10 },
    });

    expect(result.scope).toBe("workspace");
    expect(result.items.map((item) => item.ref)).toContain("workspace:file:src/chat-renderer.ts");
    expect(result.items.map((item) => item.ref)).toContain("workspace:file:README.md");
    expect(result.items.some((item) => item.snippet?.includes("inline image"))).toBe(true);
  });
});
