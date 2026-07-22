import { z } from "zod";

export const SidebarFileWorkspaceKindSchema = z.enum(["local", "sandbox"]);
export type SidebarFileWorkspaceKind = z.infer<typeof SidebarFileWorkspaceKindSchema>;

export const SidebarFileStatusSchema = z.enum(["pinned", "saved_for_later"]);
export type SidebarFileStatus = z.infer<typeof SidebarFileStatusSchema>;

export const SidebarFileBookmarkSchema = z.object({
  id: z.string().min(1),
  workspaceKind: SidebarFileWorkspaceKindSchema,
  workspaceId: z.string().min(1),
  workspaceName: z.string().min(1),
  path: z.string().min(1),
  status: SidebarFileStatusSchema,
  order: z.number().int().nonnegative().nullable().default(null),
  sourceSessionId: z.string().min(1).nullable().default(null),
  available: z.boolean().default(true),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type SidebarFileBookmark = z.infer<typeof SidebarFileBookmarkSchema>;

export const SidebarFileBookmarksResponseSchema = z.object({
  items: z.array(SidebarFileBookmarkSchema),
});

export type SidebarFileBookmarksResponse = z.infer<typeof SidebarFileBookmarksResponseSchema>;

export const PatchSidebarFileBookmarkRequestSchema = z.object({
  workspaceKind: SidebarFileWorkspaceKindSchema,
  workspaceId: z.string().trim().min(1),
  workspaceName: z.string().trim().min(1),
  path: z.string().trim().min(1),
  status: z.enum(["pinned", "saved_for_later", "none"]),
  order: z.number().int().nonnegative().nullable().optional(),
  sourceSessionId: z.string().trim().min(1).nullable().optional(),
});

export type PatchSidebarFileBookmarkRequest = z.infer<
  typeof PatchSidebarFileBookmarkRequestSchema
>;

export const ManageSidebarFileActionSchema = z.enum([
  "pin",
  "save_for_later",
  "remove",
  "list",
]);

export type ManageSidebarFileAction = z.infer<typeof ManageSidebarFileActionSchema>;

export function normalizeSidebarFilePath(input: string): string {
  let normalized = input.trim().replaceAll("\\", "/");
  normalized = normalized.replace(/^(?:workspace|sandbox):file:/, "");
  normalized = normalized.replace(/^\/workspace\/app\//, "");
  normalized = normalized.replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/")) {
    throw new Error("File path must be relative to the workspace.");
  }
  const segments = normalized.split("/").filter((segment) => segment && segment !== ".");
  if (segments.some((segment) => segment === "..")) {
    throw new Error("File path cannot leave the workspace.");
  }
  if (segments.length === 0) throw new Error("File path is required.");
  return segments.join("/");
}

export function sidebarFileBookmarkId(input: {
  workspaceKind: SidebarFileWorkspaceKind;
  workspaceId: string;
  path: string;
}): string {
  return [
    "sidebar-file",
    input.workspaceKind,
    encodeURIComponent(input.workspaceId),
    encodeURIComponent(normalizeSidebarFilePath(input.path)),
  ].join(":");
}
