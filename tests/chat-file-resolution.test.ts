import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { AppPreferencesSchema, type BootstrapPayload } from "@openpond/contracts";
import { resolveChatFile } from "../apps/server/src/workspace/resolve-chat-file";
import { createServerWorkspacePayloads } from "../apps/server/src/workspace/server-workspace-payloads";
import { upsertLocalProject } from "../apps/server/src/workspace/local-projects";
import { SqliteStore } from "../apps/server/src/store/store";
import { normalizeChatFilePath } from "../apps/web/src/lib/chat-file-links";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "openpond-file-resolution-"));
  temporary.push(root);
  const roots = [path.join(root, "one"), path.join(root, "two")];
  await Promise.all(roots.map(root => mkdir(root)));
  const file = async (name: string, content: string | Buffer = "file") => {
    const target = path.join(root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
    return target;
  };
  return { root, roots, file };
}

// A grouped project must resolve and preview files in either source folder;
// treating the group label or only its primary directory as the root breaks this.
test("grouped project resolves a named output in its second folder and previews the actual file", async () => {
  const { root, roots, file } = await fixture();
  const report = await file("two/outputs/report.pdf", "%PDF-1.4\nreport\n%%EOF");
  const image = await file("two/outputs/slide.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7l8S8AAAAASUVORK5CYII=", "base64"));
  const storeDir = path.join(root, "store");
  const store = new SqliteStore(storeDir);
  try {
    const { project } = await upsertLocalProject(store, { name: "Two projects", sourceFolders: roots, primaryFolder: roots[0] });
    const payloads = createServerWorkspacePayloads({ store, storeDir, openPondCacheScope: () => "test",
      findOpenPondApp: async () => { throw new Error("Not a hosted workspace"); },
      loadAppPreferences: async () => AppPreferencesSchema.parse({}), bootstrapPayload: async () => ({}) as BootstrapPayload });
    const resolved = await payloads.resolveWorkspaceFilePayload(project.id, "report.pdf");
    expect(resolved).toEqual({ status: "resolved", path: report, kind: "file" });
    const preview = await payloads.workspaceFilePayload(project.id, report);
    expect(preview.path).toBe(report);
    expect(Buffer.from(preview.content!, "base64").toString()).toContain("%PDF-1.4");
    expect((await payloads.workspaceImagePayload(project.id, "slide.png")).path).toBe(image);
    expect(normalizeChatFilePath(report, { workspaceRootPath: roots[1] })?.path).toBe(report);
  } finally { await store.close(); }
});

// Choosing the first basename match can open the wrong project/document. Exact
// links and useful directory suffixes disambiguate; ties require user choice.
test("exact links win and duplicate filenames produce choices", async () => {
  const { root, roots, file } = await fixture();
  const one = await file("one/docs/report.md");
  const two = await file("two/deliverables/report.md");
  const external = await file("desktop/report.md");
  const resolve = (requestedPath: string) => resolveChatFile({ roots, requestedPath, allowExternalPaths: true });
  expect(await resolve("report.md")).toEqual({ status: "ambiguous", candidates: [two, one].sort(), truncated: false });
  expect(await resolve("docs/report.md")).toEqual({ status: "resolved", path: one, kind: "file" });
  expect(await resolve("missing/deliverables/report.md")).toEqual({ status: "resolved", path: two, kind: "file" });
  expect(await resolve(external)).toEqual({ status: "resolved", path: external, kind: "file" });
  expect(await resolve(`file://${external}`)).toEqual({ status: "resolved", path: external, kind: "file" });
  expect(await resolve(`~/${path.relative(os.homedir(), external)}`)).toEqual({ status: "resolved", path: external, kind: "file" });
  await file("one/report.md"); await file("two/report.md");
  expect((await resolve("report.md")).status).toBe("ambiguous");
  expect(await resolve("two/report.md")).toEqual({ status: "resolved", path: path.join(root, "two/report.md"), kind: "file" });
});

// Discovery must stay bounded and scoped: dependencies, hidden caches, symlinks,
// and partial searches must not produce an apparently definitive wrong match.
test("discovery skips dependencies and symlinks and reports its search limit", async () => {
  const { root, roots, file } = await fixture();
  await file("one/node_modules/pkg/hidden.md");
  await file("one/.cache/hidden.md");
  const external = await file("outside/hidden.md");
  await symlink(path.join(root, "outside"), path.join(roots[0]!, "linked"), "dir");
  const resolve = (requestedPath: string, maxEntries?: number) => resolveChatFile({ roots, requestedPath, allowExternalPaths: false, maxEntries });
  expect(await resolve("hidden.md")).toEqual({ status: "missing", candidates: [], truncated: false });
  expect(await resolve(external)).toEqual({ status: "missing", candidates: [], truncated: false });
  expect(await resolve("linked/hidden.md")).toEqual({ status: "missing", candidates: [], truncated: false });
  expect(await resolve("unknown.md", 0)).toEqual({ status: "missing", candidates: [], truncated: true });
  // The exclusion is for scans, not an explicitly named dependency file.
  expect((await resolve("node_modules/pkg/hidden.md")).status).toBe("resolved");
});
