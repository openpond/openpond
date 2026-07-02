import { z } from "zod";
import { WorkspaceToolNameSchema } from "./workspace-tools.js";

export const WorkspaceProductKindSchema = z.enum([
  "sandbox_template",
  "sandbox",
  "generic_git",
  "plain_folder",
]);

export type WorkspaceProductKind = z.infer<typeof WorkspaceProductKindSchema>;

export const WorkspacePostEditCheckSchema = z.enum(["sandbox_template"]).nullable();

export type WorkspacePostEditCheck = z.infer<typeof WorkspacePostEditCheckSchema>;

export const WorkspaceCapabilitiesSchema = z.object({
  productKind: WorkspaceProductKindSchema,
  actions: z.object({
    files: z.boolean(),
    git: z.boolean(),
    sandboxRuntime: z.boolean(),
    sandboxTemplate: z.boolean(),
  }),
  checks: z.object({
    validate: WorkspaceToolNameSchema.nullable(),
    build: WorkspaceToolNameSchema.nullable(),
    postEdit: WorkspacePostEditCheckSchema,
  }),
  ui: z.object({
    showSandboxTemplateActions: z.boolean(),
    showSandboxRuntimeActions: z.boolean(),
  }),
});

export type WorkspaceCapabilities = z.infer<typeof WorkspaceCapabilitiesSchema>;
