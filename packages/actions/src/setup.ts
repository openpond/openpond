import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import type {
  ProjectActionRunRequest,
  ProjectActionSetupRequirement,
} from "./types.js";

export async function validateProjectActionStaticSetup(
  projectRoot: string,
  requirements: readonly ProjectActionSetupRequirement[],
): Promise<void> {
  for (const requirement of requirements) {
    if (requirement.required === false) continue;
    if (requirement.kind === "package") {
      try {
        createRequire(path.join(projectRoot, "package.json")).resolve(requirement.name);
      } catch {
        throw new Error(`Project Action package is not installed: ${requirement.name}`);
      }
    }
    if (requirement.kind === "native_tool" && !(await executableExists(requirement.name))) {
      throw new Error(`Project Action native tool is not installed: ${requirement.name}`);
    }
  }
}

export async function validateProjectActionRunSetup(
  projectRoot: string,
  requirements: readonly ProjectActionSetupRequirement[],
  request: ProjectActionRunRequest,
): Promise<void> {
  await validateProjectActionStaticSetup(projectRoot, requirements);
  for (const requirement of requirements) {
    if (requirement.required === false) continue;
    if (requirement.kind === "connection" && !(requirement.name in (request.connections ?? {}))) {
      throw new Error(`Project Action connection is not configured: ${requirement.name}`);
    }
    if (requirement.kind === "env" && !(requirement.name in (request.environment ?? {}))) {
      throw new Error(`Project Action environment value is not configured: ${requirement.name}`);
    }
  }
}

async function executableExists(name: string): Promise<boolean> {
  if (!name.trim() || name.includes("/") || name.includes("\\")) return false;
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidates = process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").map((extension) => path.join(directory, `${name}${extension}`))
      : [path.join(directory, name)];
    for (const candidate of candidates) {
      if (await fs.access(candidate).then(() => true).catch(() => false)) return true;
    }
  }
  return false;
}
