import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkspaceFileResolution } from "@openpond/contracts";
import { expandLocalHomePath } from "./local-output-files.js";

// These exclusions apply to discovery only. An explicit existing path wins.
const SKIP_DIRECTORIES = new Set([
  "node_modules", "vendor", "venv", "__pycache__", "coverage", "dist", "dist-types", "build", "target",
  "tmp", "temp", "htmlcov",
]);

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function kindOf(target: string): Promise<"file" | "directory" | null> {
  try {
    const stat = await fs.stat(target);
    return stat.isFile() ? "file" : stat.isDirectory() ? "directory" : null;
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
}

/** Resolve exact links first, then discover names only inside the project's roots.
 * Never follow symlinks during discovery or silently pick an incomplete/ambiguous result. */
export async function resolveChatFile(input: {
  roots: string[];
  requestedPath: string;
  allowExternalPaths: boolean;
  maxEntries?: number;
  maxDurationMs?: number;
}): Promise<WorkspaceFileResolution> {
  let requested = input.requestedPath.trim();
  if (!requested || requested.includes("\0") || requested.length > 4096) throw new Error("Invalid file path");
  if (/^file:\/\//i.test(requested)) requested = fileURLToPath(requested);
  requested = expandLocalHomePath(requested).replace(/[\\/]+$/, "");
  const roots = [...new Set(await Promise.all(input.roots.map(root => fs.realpath(root))))];
  const exact = new Map<string, "file" | "directory">();
  const absolute = path.isAbsolute(requested);
  const addExact = async (candidate: string) => {
    const kind = await kindOf(candidate);
    if (!kind) return;
    const real = await fs.realpath(candidate);
    if (!input.allowExternalPaths && !roots.some(root => within(root, real))) return;
    exact.set(real, kind);
  };
  if (absolute) {
    if (input.allowExternalPaths || roots.some(root => within(root, requested))) await addExact(requested);
  } else {
    for (const root of roots) {
      const candidate = path.resolve(root, requested);
      if (within(root, candidate)) await addExact(candidate);
    }
    // Models sometimes prefix a relative link with a source folder's name.
    if (exact.size === 0) for (const root of roots) {
      const prefix = `${path.basename(root)}${path.sep}`;
      if (requested.startsWith(prefix)) {
        const candidate = path.resolve(root, requested.slice(prefix.length));
        if (within(root, candidate)) await addExact(candidate);
      }
    }
  }
  if (exact.size === 1) {
    const [resolved, kind] = [...exact][0]!;
    return { status: "resolved", path: resolved, kind };
  }
  if (exact.size > 1) return { status: "ambiguous", candidates: [...exact.keys()].sort(), truncated: false };
  // Missing absolute links may be recovered inside the project, never by scanning
  // their parent directory (which could be the user's home or filesystem root).
  const basename = path.basename(requested);
  if (!basename || basename === "." || basename === "..") return { status: "missing", candidates: [], truncated: false };
  const requestedParts = requested.split(path.sep);
  const candidates = new Map<string, { kind: "file" | "directory"; score: number }>();
  const queue = roots.map(root => ({ root, directory: root, depth: 0 }));
  const visited = new Set<string>();
  const deadline = Date.now() + (input.maxDurationMs ?? 2500);
  let remaining = input.maxEntries ?? 50_000;
  let truncated = false;
  let stopped = false;
  while (queue.length && !stopped) {
    // Read a small batch in parallel; serial opendir/realpath round trips make
    // even ordinary monorepos hit the deadline before reaching their sources.
    const batch = queue.splice(0, 12);
    await Promise.all(batch.map(async item => {
      if (visited.has(item.directory) || stopped) return;
      visited.add(item.directory);
      if (Date.now() >= deadline || remaining <= 0) { truncated = stopped = true; return; }
      try {
        const realDirectory = await fs.realpath(item.directory);
        if (!within(item.root, realDirectory)) return;
        const directory = await fs.opendir(realDirectory, { bufferSize: 128 });
        for await (const entry of directory) {
          if (stopped) break;
          if (--remaining < 0 || Date.now() >= deadline) { truncated = stopped = true; break; }
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory() && (entry.name.startsWith(".") || SKIP_DIRECTORIES.has(entry.name) || entry.name.endsWith(".egg-info"))) continue;
          const target = path.join(realDirectory, entry.name);
          if (entry.name === basename && (entry.isFile() || entry.isDirectory())) {
            const real = await fs.realpath(target);
            if (within(item.root, real)) {
              const parts = target.split(path.sep);
              let score = 0;
              while (score < Math.min(parts.length, requestedParts.length) && parts.at(-1 - score) === requestedParts.at(-1 - score)) score++;
              candidates.set(real, { kind: entry.isDirectory() ? "directory" : "file", score });
            }
            if (candidates.size >= 30) { truncated = stopped = true; break; }
          }
          if (entry.isDirectory()) {
            if (item.depth >= 12) { truncated = true; continue; }
            queue.push({ root: item.root, directory: target, depth: item.depth + 1 });
          }
        }
      } catch (error) {
        if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        truncated = true;
      }
    }));
  }
  const matches = [...candidates].sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]));
  if (!truncated && matches.length > 0 && (matches.length === 1 || matches[0]![1].score > matches[1]![1].score)) {
    const [resolved, { kind }] = matches[0]!;
    return { status: "resolved", path: resolved, kind };
  }
  return { status: matches.length ? "ambiguous" : "missing", candidates: matches.map(([target]) => target), truncated };
}
