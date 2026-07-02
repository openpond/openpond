import { promises as fs, constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LspClient } from "./lsp";
import {
  commitFiles,
  deployApp,
  fetchToolManifest,
  type ToolManifest,
} from "./api";
import { runProcessCommand } from "./process-runner";

export type ToolExecutionContext = {
  rootDir: string;
  readSet: Set<string>;
  baseUrl: string;
  token: string;
  appId: string;
  lsp?: LspClient | null;
};

export type ToolExecutionResult = {
  ok: boolean;
  output?: unknown;
  error?: string;
};

type ToolCall = {
  name: string;
  args?: Record<string, unknown>;
};

const manifestCache = new Map<string, Promise<ToolManifest>>();
const allowedToolsCache = new Map<string, Promise<Set<string>>>();

async function getAllowedTools(
  baseUrl: string,
  token: string
): Promise<Set<string>> {
  const cacheKey = baseUrl.replace(/\/$/, "");
  if (!allowedToolsCache.has(cacheKey)) {
    const manifestPromise =
      manifestCache.get(cacheKey) ?? fetchToolManifest(baseUrl, token);
    manifestCache.set(cacheKey, manifestPromise);
    allowedToolsCache.set(
      cacheKey,
      manifestPromise.then(
        (manifest) => new Set(manifest.tools.map((tool) => tool.function.name))
      )
    );
  }
  return allowedToolsCache.get(cacheKey)!;
}

function resolvePath(rootDir: string, filePath: string): string {
  const resolved = path.resolve(rootDir, filePath);
  const relative = path.relative(rootDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path is outside workspace");
  }
  return resolved;
}

function ensureReadBeforeWrite(readSet: Set<string>, filePath: string) {
  if (!readSet.has(filePath)) {
    throw new Error("File must be read before write/patch");
  }
}

async function readFileTool(
  ctx: ToolExecutionContext,
  args: Record<string, unknown>
) {
  const filePath = String(args.path || "");
  if (!filePath) throw new Error("path is required");
  const resolved = resolvePath(ctx.rootDir, filePath);
  const content = await fs.readFile(resolved, "utf-8");
  ctx.readSet.add(resolved);
  if (ctx.lsp) {
    try {
      await ctx.lsp.syncFile(resolved, content);
    } catch {
      // ignore LSP sync errors
    }
  }
  return { path: filePath, content };
}

async function listFilesTool(
  ctx: ToolExecutionContext,
  args: Record<string, unknown>
) {
  const pattern = String(args.pattern || "**/*");
  const glob = new Bun.Glob(pattern);
  const matches: string[] = [];
  for await (const entry of glob.scan({ cwd: ctx.rootDir, dot: true })) {
    matches.push(entry);
  }
  return { pattern, matches };
}

async function grepTool(
  ctx: ToolExecutionContext,
  args: Record<string, unknown>
) {
  const query = String(args.query || "");
  const pattern = String(args.pattern || ".");
  if (!query) throw new Error("query is required");
  const result = await runProcessCommand("rg", [query, pattern], {
    cwd: ctx.rootDir,
  });
  if (result.code !== 0 && result.code !== 1) {
    throw new Error(result.stderr || "rg failed");
  }
  return { query, pattern, matches: result.stdout.trim() };
}

function parsePatchPaths(patchText: string): string[] {
  const paths: string[] = [];
  const lines = patchText.split("\n");
  for (const line of lines) {
    if (line.startsWith("+++ ")) {
      const value = line.slice(4).trim();
      if (value.startsWith("b/")) {
        paths.push(value.slice(2));
      }
    }
  }
  return paths;
}

async function applyPatchTool(
  ctx: ToolExecutionContext,
  args: Record<string, unknown>
) {
  const patchText = String(args.patch || "");
  if (!patchText) throw new Error("patch is required");
  const touched = parsePatchPaths(patchText);
  const beforeMap: Record<string, string> = {};
  for (const filePath of touched) {
    const resolved = resolvePath(ctx.rootDir, filePath);
    ensureReadBeforeWrite(ctx.readSet, resolved);
    beforeMap[filePath] = await fs.readFile(resolved, "utf-8");
  }

  const result = await runProcessCommand("git", ["apply", "--whitespace=nowarn", "-"], {
    cwd: ctx.rootDir,
    stdin: patchText,
  });
  if (result.code !== 0) {
    throw new Error(result.stderr || "git apply failed");
  }
  const files: Array<{
    path: string;
    before: string;
    after: string;
    diff: string;
  }> = [];
  for (const filePath of touched) {
    const resolved = resolvePath(ctx.rootDir, filePath);
    const content = await fs.readFile(resolved, "utf-8");
    const diff = await createUnifiedDiff(
      beforeMap[filePath] ?? "",
      content,
      filePath
    );
    files.push({
      path: filePath,
      before: beforeMap[filePath] ?? "",
      after: content,
      diff,
    });
    if (ctx.lsp) {
      try {
        await ctx.lsp.syncFile(resolved, content);
      } catch {
        // ignore LSP sync errors
      }
    }
  }
  return { files };
}

async function writeFileTool(
  ctx: ToolExecutionContext,
  args: Record<string, unknown>
) {
  const filePath = String(args.path || "");
  const content = String(args.content || "");
  if (!filePath) throw new Error("path is required");
  const resolved = resolvePath(ctx.rootDir, filePath);
  const exists = await fs
    .access(resolved, fsConstants.F_OK)
    .then(() => true)
    .catch(() => false);
  let previous = "";
  if (exists) {
    ensureReadBeforeWrite(ctx.readSet, resolved);
    previous = await fs.readFile(resolved, "utf-8");
  }
  await fs.writeFile(resolved, content, "utf-8");
  if (ctx.lsp) {
    try {
      await ctx.lsp.syncFile(resolved, content);
    } catch {
      // ignore LSP sync errors
    }
  }
  const diff = await createUnifiedDiff(previous, content, filePath);
  return {
    path: filePath,
    created: !exists,
    diff,
    before: previous,
    after: content,
  };
}

async function createUnifiedDiff(
  before: string,
  after: string,
  filePath: string
): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openpond-diff-"));
  const beforePath = path.join(tmpDir, "before");
  const afterPath = path.join(tmpDir, "after");
  await fs.writeFile(beforePath, before, "utf-8");
  await fs.writeFile(afterPath, after, "utf-8");
  try {
    const result = await runProcessCommand(
      "diff",
      [
        "-u",
        "--label",
        `a/${filePath}`,
        "--label",
        `b/${filePath}`,
        beforePath,
        afterPath,
      ],
      { cwd: tmpDir }
    );
    if (result.code !== 0 && result.code !== 1) {
      throw new Error(result.stderr || "diff failed");
    }
    return result.stdout.trim();
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function collectChangedFiles(
  rootDir: string
): Promise<Record<string, string>> {
  const result = await runProcessCommand("git", ["status", "--porcelain", "-uall"], {
    cwd: rootDir,
  });
  if (result.code !== 0) {
    throw new Error(result.stderr || "git status failed");
  }

  const files: Record<string, string> = {};
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue;
    const status = line.slice(0, 2);
    const filePath = line.slice(3).trim();
    if (status.includes("D")) {
      throw new Error(`Deletion not supported: ${filePath}`);
    }
    const absolute = path.join(rootDir, filePath);
    const content = await fs.readFile(absolute, "utf-8");
    files[filePath] = content;
  }
  if (Object.keys(files).length === 0) {
    throw new Error("No changes detected");
  }
  return files;
}

async function deployTool(
  ctx: ToolExecutionContext,
  args: Record<string, unknown>
) {
  const message = String(args.message || "Deploy from TUI");
  const files = await collectChangedFiles(ctx.rootDir);
  const commit = await commitFiles(
    ctx.baseUrl,
    ctx.token,
    ctx.appId,
    files,
    message
  );
  const deployment = await deployApp(ctx.baseUrl, ctx.token, ctx.appId);
  return {
    commitSha: commit.commitSha,
    deploymentId: deployment.deploymentId,
  };
}

export async function executeLocalTool(
  call: ToolCall,
  ctx: ToolExecutionContext
): Promise<ToolExecutionResult> {
  try {
    const allowedTools = await getAllowedTools(ctx.baseUrl, ctx.token);
    if (!allowedTools.has(call.name)) {
      return { ok: false, error: `Tool not in manifest: ${call.name}` };
    }
    switch (call.name) {
      case "read_file":
        return { ok: true, output: await readFileTool(ctx, call.args || {}) };
      case "list_files":
        return { ok: true, output: await listFilesTool(ctx, call.args || {}) };
      case "grep":
        return { ok: true, output: await grepTool(ctx, call.args || {}) };
      case "apply_patch":
        return { ok: true, output: await applyPatchTool(ctx, call.args || {}) };
      case "write_file":
        return { ok: true, output: await writeFileTool(ctx, call.args || {}) };
      case "deploy":
        return { ok: true, output: await deployTool(ctx, call.args || {}) };
      default:
        return { ok: false, error: `Unknown tool: ${call.name}` };
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Tool failed",
    };
  }
}
