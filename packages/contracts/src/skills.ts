import { z } from "zod";

export const CodexPersonalSkillSchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
  sourcePath: z.string(),
  enabled: z.boolean(),
  charCount: z.number().int().nonnegative(),
  sourceHash: z.string(),
  validationStatus: z.enum(["valid", "error"]),
  validationMessages: z.array(z.string()),
  resourceFiles: z.array(z.string()),
  updatedAt: z.string().nullable(),
});

export type CodexPersonalSkill = z.infer<typeof CodexPersonalSkillSchema>;

export const SkillSourceScopeSchema = z.enum(["codex", "profile"]);

export const SkillSourceFileSchema = z.object({
  skillName: z.string(),
  scope: SkillSourceScopeSchema,
  path: z.string(),
  byteSize: z.number().int().nonnegative(),
  isBinary: z.boolean(),
  content: z.string().nullable(),
});

export type SkillSourceScope = z.infer<typeof SkillSourceScopeSchema>;
export type SkillSourceFile = z.infer<typeof SkillSourceFileSchema>;
