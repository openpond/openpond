import { z } from "zod";
import { PonderDesktopScopeSchema } from "./ponder-desktop.js";
export const PonderDesktopProjectAuthoritySchema = z
  .object({
    scope: PonderDesktopScopeSchema,
    authorizationRevision: z.number().int().positive(),
  })
  .strict();
export const PonderDesktopProjectChoiceSchema = z
  .object({
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(300),
    cwd: z.string().min(1).max(8192).nullable(),
    revision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    available: z.boolean(),
    previouslyShared: z.boolean(),
    shared: z.boolean(),
  })
  .strict();
export const PonderDesktopProjectPageSchema = z
  .object({
    authority: PonderDesktopProjectAuthoritySchema.nullable(),
    projects: PonderDesktopProjectChoiceSchema.array().max(100),
    nextCursor: z.string().min(1).max(200).nullable(),
  })
  .strict();
export const PonderDesktopProjectSharingRequestSchema = z
  .object({
    projectId: z.string().min(1).max(200),
    shared: z.boolean(),
    expectedRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    expectedAuthority: PonderDesktopProjectAuthoritySchema,
  })
  .strict();
export type PonderDesktopProjectChoice = z.infer<typeof PonderDesktopProjectChoiceSchema>;
export const PonderDesktopProjectSharingResponseSchema = z
  .object({
    projectId: z.string().min(1).max(200),
    shared: z.boolean(),
    discovery: z.enum(["current", "pending"]),
  })
  .strict();
export type PonderDesktopProjectAuthority = z.infer<typeof PonderDesktopProjectAuthoritySchema>;
