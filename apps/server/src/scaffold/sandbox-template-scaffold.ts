import { promises as fs } from "node:fs";
import path from "node:path";

import {
  OPENPOND_MANIFEST_FILE_NAME,
  sandboxTemplateScaffoldFiles,
} from "@openpond/cloud/sandbox-template/manifest";

type SandboxTemplateScaffoldInput = {
  manifestOnly?: boolean;
  manifestContent?: string | null;
  manifestPath?: string | null;
  projectName: string;
};

export async function writeSandboxTemplateScaffold(
  repoPath: string,
  input: SandboxTemplateScaffoldInput,
): Promise<{ files: string[] }> {
  const manifestPath = normalizeManifestPath(input.manifestPath);
  const files = sandboxTemplateScaffoldFiles({ name: input.projectName });
  const defaultManifestContent = files[OPENPOND_MANIFEST_FILE_NAME] ?? "";
  if (manifestPath !== OPENPOND_MANIFEST_FILE_NAME) {
    delete files[OPENPOND_MANIFEST_FILE_NAME];
  }
  if (input.manifestContent?.trim()) {
    files[manifestPath] = `${input.manifestContent.trim()}\n`;
  } else if (manifestPath !== OPENPOND_MANIFEST_FILE_NAME) {
    files[manifestPath] = defaultManifestContent;
  }
  if (input.manifestOnly) {
    for (const relativePath of Object.keys(files)) {
      if (relativePath !== manifestPath) delete files[relativePath];
    }
  }
  const existingManifest = path.join(repoPath, manifestPath);
  if (await fileExists(existingManifest)) {
    throw new Error(`${manifestPath} already exists in this project.`);
  }
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(repoPath, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents, "utf8");
  }
  return { files: Object.keys(files).sort((left, right) => left.localeCompare(right)) };
}

function normalizeManifestPath(value?: string | null): string {
  const trimmed = value?.trim() || OPENPOND_MANIFEST_FILE_NAME;
  const normalized = path.posix.normalize(trimmed.replace(/\\/g, "/")).replace(/^\/+/, "");
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error("Manifest path must stay inside the project.");
  }
  return normalized;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}
