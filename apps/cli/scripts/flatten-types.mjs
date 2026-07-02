import { cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const distRoot = path.join(packageRoot, "dist");
const cloudTypesRoot = path.join(distRoot, "packages", "cloud", "src");
const cliTypesRoot = path.join(distRoot, "apps", "cli", "src");

async function copyTree(source, target, options = {}) {
  const entries = await readdir(source, { withFileTypes: true });
  await mkdir(target, { recursive: true });
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      await copyTree(sourcePath, targetPath, options);
      continue;
    }
    if (options.skipExisting) {
      try {
        await cp(sourcePath, targetPath, { errorOnExist: true, force: false });
        continue;
      } catch (error) {
        if (error?.code === "ERR_FS_CP_EEXIST" || error?.code === "EEXIST") {
          continue;
        }
        throw error;
      }
    }
    await cp(sourcePath, targetPath, { force: true });
  }
}

await copyTree(cloudTypesRoot, distRoot);
await cp(path.join(cliTypesRoot, "index.d.ts"), path.join(distRoot, "index.d.ts"), {
  force: true,
});

await rm(path.join(distRoot, "apps"), { recursive: true, force: true });
await rm(path.join(distRoot, "packages"), { recursive: true, force: true });
