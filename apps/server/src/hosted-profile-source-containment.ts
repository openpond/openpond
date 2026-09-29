import path from "node:path";

/** The published Profile may use the repository root or a directory beneath it. */
export function isHostedProfileSourceWithinRepo(repoPath: string, sourcePath: string): boolean {
  const repo = path.resolve(repoPath);
  const source = path.resolve(sourcePath);
  return source === repo || source.startsWith(`${repo}${path.sep}`);
}
