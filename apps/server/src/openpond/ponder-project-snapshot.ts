import { listLocalRecords } from "@openpond/persistence";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { z } from "zod";
import {
  PONDER_DESKTOP_CATALOG_MAX_TARGETS,
  LocalProjectSchema,
  ponderDesktopRequestContent,
  type LocalProject,
} from "@openpond/contracts";

const hash = (value: unknown) =>
  createHash("sha256")
    .update(ponderDesktopRequestContent("POST", "/local/ponder-project", value))
    .digest("hex");
export const PonderProjectSnapshotSchema = z
  .object({
    projectId: z.string().min(1).max(200),
    name: z.string().min(1).max(300),
    cwd: z.string().min(1).max(8192),
    sourceFolders: z
      .array(
        z
          .object({ path: z.string().min(1).max(8192), realpath: z.string().min(1).max(8192) })
          .strict(),
      )
      .min(1)
      .max(1000),
    configurationHash: z.string().regex(/^[a-f0-9]{64}$/),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type PonderProjectSnapshot = z.infer<typeof PonderProjectSnapshotSchema>;

/** Read saved project identities without running unrelated Sandbox template scans. */
export function readPonderLocalProjects(home: string) {
  const records = Object.values(listLocalRecords<LocalProject>(home, "saved_local_projects"));
  if (records.length > PONDER_DESKTOP_CATALOG_MAX_TARGETS)
    throw new Error("ponder_desktop_project_sharing_limit_exceeded");
  return records.map((record) => LocalProjectSchema.parse(record.value));
}

/** A saved ID alone cannot authorize a changed path, folder collection or symlink destination. */
export async function capturePonderProjectSnapshot(
  project: LocalProject,
): Promise<PonderProjectSnapshot> {
  if (project.hiddenFromDefaultSidebar) throw new Error("ponder_desktop_project_unavailable");
  const directories = [
    ...new Set([
      ...(project.sourceFolders ?? [project.path]),
      project.path,
      ...(project.repoPath ? [project.repoPath] : []),
    ]),
  ];
  if (!directories.length || directories.length > 1000)
    throw new Error("ponder_desktop_project_folder_limit_exceeded");
  const cwd = await realpath(project.workspacePath);
  if (!(await stat(cwd)).isDirectory()) throw new Error("ponder_desktop_project_unavailable");
  const sourceFolders = [];
  for (const directory of directories) {
    const resolved = await realpath(directory);
    if (!(await stat(resolved)).isDirectory())
      throw new Error("ponder_desktop_project_unavailable");
    sourceFolders.push({ path: directory, realpath: resolved });
  }
  const snapshot = {
    projectId: project.id,
    name: project.name,
    cwd,
    sourceFolders,
    configurationHash: hash({
      id: project.id,
      name: project.name,
      path: project.path,
      workspacePath: project.workspacePath,
      repoPath: project.repoPath,
      sourceFolders: project.sourceFolders ?? null,
      hiddenFromDefaultSidebar: project.hiddenFromDefaultSidebar ?? false,
    }),
  };
  return PonderProjectSnapshotSchema.parse({ ...snapshot, revision: hash(snapshot) });
}
