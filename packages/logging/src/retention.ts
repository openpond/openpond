import { promises as fs } from "node:fs";
import path from "node:path";

/** Logs are disposable; unrelated files and user exports are never candidates. */
export async function pruneLogs(directory: string, currentFile: string, now = Date.now()): Promise<void> {
  const files: { file: string; size: number; modified: number }[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.log(?:\.\d+)?$/.test(entry.name)) continue;
    const file = path.join(directory, entry.name), stat = await fs.lstat(file).catch((error) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; });
    if (stat?.isFile()) files.push({ file, size: stat.size, modified: stat.mtimeMs });
  }
  let bytes = files.reduce((total, entry) => total + entry.size, 0);
  for (const entry of files.sort((a, b) => a.modified - b.modified)) {
    if (entry.file === currentFile || entry.modified >= now - 14 * 86_400_000 && bytes <= 256 * 1024 * 1024) continue;
    const current = await fs.lstat(entry.file).catch(() => null);
    if (current?.isFile() && current.size === entry.size && current.mtimeMs === entry.modified) {
      await fs.rm(entry.file, { force: true }); bytes -= entry.size;
    }
  }
}
