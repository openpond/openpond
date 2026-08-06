import { z } from "zod";

import { ReleaseHashSchema, ReleaseIdSchema } from "./common.js";

export const ModelRefSchema = z.object({
  provider: ReleaseIdSchema,
  model: ReleaseIdSchema,
  revision: z.string().trim().min(1).max(500).nullable().default(null),
  artifactHash: ReleaseHashSchema.nullable().default(null),
  tokenizerRevision: z.string().trim().min(1).max(500).nullable().default(null),
  chatTemplateHash: ReleaseHashSchema.nullable().default(null),
}).strict();

export type ModelRef = z.infer<typeof ModelRefSchema>;
