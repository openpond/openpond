import { promises as fs } from "node:fs";
import path from "node:path";
import { runWorkspaceCommand } from "../workspace/workspace-command.js";

export const MAX_REPOSITORY_INSTRUCTION_FILE_BYTES = 64 * 1024;

const REPOSITORY_INSTRUCTION_FILE_NAME = "AGENTS.md";
const REPOSITORY_INSTRUCTION_OVERRIDE_FILE_NAME = "AGENTS.override.md";

export type RepositoryInstructionSource = {
  absolutePath: string;
  relativePath: string;
  content: string;
};

export type RepositoryInstructionResolution = {
  repositoryRoot: string;
  workingDirectory: string;
  sources: RepositoryInstructionSource[];
  diagnostics: string[];
};

type CandidateReadResult =
  | { status: "missing" }
  | { status: "loaded"; source: RepositoryInstructionSource }
  | { status: "rejected"; diagnostic: string };

export async function resolveRepositoryInstructions(
  workspacePath: string | null | undefined,
): Promise<RepositoryInstructionResolution | null> {
  if (!workspacePath) return null;

  const workingDirectory = await canonicalDirectory(workspacePath);
  if (!workingDirectory) return null;

  const repositoryRoot = await resolveRepositoryRoot(workingDirectory);
  const sources: RepositoryInstructionSource[] = [];
  const diagnostics: string[] = [];
  const seenSourcePaths = new Set<string>();

  for (const directory of directoriesFromRoot(
    repositoryRoot,
    workingDirectory,
  )) {
    const override = await readInstructionCandidate({
      directory,
      fileName: REPOSITORY_INSTRUCTION_OVERRIDE_FILE_NAME,
      repositoryRoot,
    });
    if (override.status === "loaded") {
      addSource(override.source, sources, seenSourcePaths);
      continue;
    }
    if (override.status === "rejected") diagnostics.push(override.diagnostic);

    const standard = await readInstructionCandidate({
      directory,
      fileName: REPOSITORY_INSTRUCTION_FILE_NAME,
      repositoryRoot,
    });
    if (standard.status === "loaded") {
      addSource(standard.source, sources, seenSourcePaths);
    } else if (standard.status === "rejected") {
      diagnostics.push(standard.diagnostic);
    }
  }

  return {
    repositoryRoot,
    workingDirectory,
    sources,
    diagnostics,
  };
}

export function buildRepositoryInstructionContext(
  resolution: RepositoryInstructionResolution | null,
): string {
  if (!resolution?.sources.length) return "";
  const sections = resolution.sources.map((source) => {
    const label = JSON.stringify(source.relativePath);
    return [
      `Repository instruction source ${label}:`,
      source.content.trim(),
      `End repository instruction source ${label}.`,
    ]
      .filter(Boolean)
      .join("\n");
  });
  return [
    "Repository instructions:",
    "- Follow the applicable instructions below for work in this repository.",
    "- Sources are ordered from the repository root toward the active working directory; later sources are more specific.",
    ...sections,
  ].join("\n\n");
}

async function canonicalDirectory(inputPath: string): Promise<string | null> {
  try {
    const resolved = await fs.realpath(path.resolve(inputPath));
    const stat = await fs.stat(resolved);
    return stat.isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

async function resolveRepositoryRoot(workingDirectory: string): Promise<string> {
  const result = await runWorkspaceCommand(
    "git",
    ["rev-parse", "--show-toplevel"],
    workingDirectory,
  );
  if (result.code !== 0 || !result.stdout.trim()) return workingDirectory;

  const gitRoot = await canonicalDirectory(result.stdout.trim());
  return gitRoot && isWithinDirectory(gitRoot, workingDirectory)
    ? gitRoot
    : workingDirectory;
}

function directoriesFromRoot(
  repositoryRoot: string,
  workingDirectory: string,
): string[] {
  if (!isWithinDirectory(repositoryRoot, workingDirectory)) {
    return [workingDirectory];
  }
  const relative = path.relative(repositoryRoot, workingDirectory);
  const directories = [repositoryRoot];
  if (!relative) return directories;

  let current = repositoryRoot;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    directories.push(current);
  }
  return directories;
}

async function readInstructionCandidate(input: {
  directory: string;
  fileName: string;
  repositoryRoot: string;
}): Promise<CandidateReadResult> {
  const candidatePath = path.join(input.directory, input.fileName);
  let realPath: string;
  try {
    realPath = await fs.realpath(candidatePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing" };
    }
    return {
      status: "rejected",
      diagnostic: `Could not resolve repository instruction file: ${candidatePath}`,
    };
  }

  if (!isWithinDirectory(input.repositoryRoot, realPath)) {
    return {
      status: "rejected",
      diagnostic: `Skipped repository instruction file outside the repository boundary: ${candidatePath}`,
    };
  }

  try {
    const stat = await fs.stat(realPath);
    if (!stat.isFile()) {
      return {
        status: "rejected",
        diagnostic: `Skipped repository instruction path that is not a file: ${candidatePath}`,
      };
    }
    if (stat.size > MAX_REPOSITORY_INSTRUCTION_FILE_BYTES) {
      return {
        status: "rejected",
        diagnostic: `Skipped repository instruction file larger than ${MAX_REPOSITORY_INSTRUCTION_FILE_BYTES} bytes: ${candidatePath}`,
      };
    }
    return {
      status: "loaded",
      source: {
        absolutePath: realPath,
        relativePath: path.relative(input.repositoryRoot, candidatePath),
        content: await fs.readFile(realPath, "utf8"),
      },
    };
  } catch {
    return {
      status: "rejected",
      diagnostic: `Could not read repository instruction file: ${candidatePath}`,
    };
  }
}

function addSource(
  source: RepositoryInstructionSource,
  sources: RepositoryInstructionSource[],
  seenSourcePaths: Set<string>,
): void {
  if (seenSourcePaths.has(source.absolutePath)) return;
  seenSourcePaths.add(source.absolutePath);
  sources.push(source);
}

function isWithinDirectory(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}
