import { z } from "zod";
const Id = z.string().trim().min(1).max(240);

/** Account-owned defaults. Resolving them never creates resources or enables learning. */
export const CorrectionsDefaultSchema = z.object({
  scopeKey: z.string().regex(/^[a-f0-9]{64}$/),
  teamId: Id,
  actorId: Id,
  defaultDatasetId: Id,
  selectionRevision: z.number().int().nonnegative(),
  destinationError: z.string().nullable(),
  modelId: Id,
  graderDraftId: Id,
  graderState: z.enum(["draft", "unavailable"]),
  dataset: z.object({ id: Id, name: z.string().min(1).max(500), revision: z.number().int().positive() }).strict().nullable(),
}).strict();
export type CorrectionsDefault = z.infer<typeof CorrectionsDefaultSchema>;
