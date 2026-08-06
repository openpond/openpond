import {
  GraderInterfaceContractSchema,
  LifecycleContractSchema,
  ToolDeclarationSchema,
} from "@openpond/evals";
import { z } from "zod";

import { ReleaseIdSchema } from "./release-core.js";

const SafeRelativePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_000)
  .refine((value) => {
    const normalized = value.replaceAll("\\", "/");
    return (
      !normalized.startsWith("/") &&
      !normalized.includes("\0") &&
      !normalized.split("/").some((part) => !part || part === "." || part === "..")
    );
  }, "path must be a safe relative path");

export const HarnessSourceFileKindSchema = z.enum([
  "instruction",
  "skill",
  "skill_resource",
  "agent",
  "dependency_lock",
  "program",
  "asset",
]);

export const HarnessSourceFileSchema = z
  .object({
    id: ReleaseIdSchema,
    kind: HarnessSourceFileKindSchema,
    path: SafeRelativePathSchema,
    parentId: ReleaseIdSchema.nullable(),
    mediaType: z.string().trim().min(1).max(200),
    visibility: z.enum(["policy", "verifier", "host_private"]),
    portability: z.enum(["portable", "local_only"]),
  })
  .strict()
  .superRefine((file, context) => {
    if ((file.kind === "skill_resource") !== (file.parentId !== null)) {
      context.addIssue({
        code: "custom",
        message: "only Skill resources require parentId",
        path: ["parentId"],
      });
    }
  });

/** Host-neutral mutable source package read by both local and hosted compilers. */
export const HarnessSourceManifestSchema = z
  .object({
    schemaVersion: z.literal("openpond.harnessSourceManifest.v1"),
    name: z.string().trim().min(1).max(240),
    files: z.array(HarnessSourceFileSchema).min(2).max(100_000),
    toolDeclarations: z.array(ToolDeclarationSchema).max(200),
    capabilityRequirements: z
      .array(
        z
          .object({
            id: ReleaseIdSchema,
            required: z.boolean(),
            scopes: z.array(z.string().trim().min(1).max(500)).max(100),
          })
          .strict(),
      )
      .max(200),
    lifecycle: LifecycleContractSchema,
    graderInterface: GraderInterfaceContractSchema,
    runtimeProtocol: z.string().trim().min(1).max(500),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .superRefine((manifest, context) => {
    const ids = new Set<string>();
    const kindsById = new Map<string, z.infer<typeof HarnessSourceFileKindSchema>>();
    const paths = new Set<string>();
    for (const [index, file] of manifest.files.entries()) {
      if (ids.has(file.id)) {
        context.addIssue({ code: "custom", message: "file ids must be unique", path: ["files", index, "id"] });
      }
      if (paths.has(file.path)) {
        context.addIssue({ code: "custom", message: "file paths must be unique", path: ["files", index, "path"] });
      }
      ids.add(file.id);
      kindsById.set(file.id, file.kind);
      paths.add(file.path);
    }
    for (const [index, file] of manifest.files.entries()) {
      if (file.parentId && !ids.has(file.parentId)) {
        context.addIssue({ code: "custom", message: "parentId must reference a declared Skill", path: ["files", index, "parentId"] });
      } else if (file.parentId && kindsById.get(file.parentId) !== "skill") {
        context.addIssue({ code: "custom", message: "parentId must reference a primary Skill file", path: ["files", index, "parentId"] });
      }
    }
    if (manifest.files.filter((file) => file.kind === "dependency_lock").length !== 1) {
      context.addIssue({ code: "custom", message: "exactly one dependency lock is required", path: ["files"] });
    }
    if (manifest.files.filter((file) => file.kind === "program").length !== 1) {
      context.addIssue({ code: "custom", message: "exactly one Harness program is required", path: ["files"] });
    }
  });

export type HarnessSourceFileKind = z.infer<typeof HarnessSourceFileKindSchema>;
export type HarnessSourceFile = z.infer<typeof HarnessSourceFileSchema>;
export type HarnessSourceManifest = z.infer<typeof HarnessSourceManifestSchema>;
