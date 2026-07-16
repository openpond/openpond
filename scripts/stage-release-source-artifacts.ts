import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceDirectories = ["apps", "packages"] as const;

export type StageReleaseSourceArtifactsOptions = {
  root?: string;
  outputDirectory?: string;
};

export async function stageReleaseSourceArtifacts(
  options: StageReleaseSourceArtifactsOptions = {},
): Promise<string[]> {
  const root = path.resolve(
    options.root ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."),
  );
  const outputDirectory = path.resolve(
    options.outputDirectory ?? path.join(root, "release-source-artifacts"),
  );

  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });

  const stagedOutputs: string[] = [];
  for (const workspaceDirectory of workspaceDirectories) {
    const workspaceRoot = path.join(root, workspaceDirectory);
    const entries = await readdir(workspaceRoot, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory()) continue;

      const source = path.join(workspaceRoot, entry.name, "dist");
      const sourceStat = await stat(source).catch(() => null);
      if (!sourceStat?.isDirectory()) continue;

      const relativeSource = path.relative(root, source);
      const destination = path.join(outputDirectory, relativeSource);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(source, destination, { recursive: true });
      stagedOutputs.push(relativeSource.split(path.sep).join("/"));
    }
  }

  if (stagedOutputs.length === 0) {
    throw new Error("No application or workspace dist directories were available to stage.");
  }

  return stagedOutputs;
}

if (import.meta.main) {
  const stagedOutputs = await stageReleaseSourceArtifacts();
  console.log(`Staged ${stagedOutputs.length} release source outputs:`);
  for (const output of stagedOutputs) console.log(`- ${output}`);
}
