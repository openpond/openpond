import path from "node:path";

type SourceReadTool = "profile_skill_read" | "skill_inspect" | "context_read";

/** Named skill resources remain inside their released public package. Context
 * reads address an exact source-root path and never infer a skill name. */
export function resolveProfilePolicySourcePath(
  tool: SourceReadTool,
  args: Record<string, unknown>,
  publicHashes: Record<string, string>,
  skillPaths: ReadonlyMap<string, string>,
): string {
  const denied = () => new Error("This source file is outside the public policy closure.");
  let selected: string;
  if (tool === "context_read") {
    if (typeof args.path !== "string") throw denied();
    selected = args.path;
  } else {
    // Names identify admitted skills; they never become filesystem segments.
    const skillPath = typeof args.name === "string" ? skillPaths.get(args.name.trim()) : undefined;
    if (!skillPath || !Object.hasOwn(publicHashes, skillPath)) throw denied();
    if (args.path === undefined) return skillPath;
    const resource = args.path;
    if (typeof resource !== "string" || !resource || resource.includes("\\")
      || resource.includes("\0") || path.posix.isAbsolute(resource)
      || path.win32.isAbsolute(resource) || resource.split("/").includes("..")) throw denied();
    selected = path.posix.join(path.posix.dirname(skillPath), resource);
  }
  if (!Object.hasOwn(publicHashes, selected)) throw denied();
  return selected;
}
