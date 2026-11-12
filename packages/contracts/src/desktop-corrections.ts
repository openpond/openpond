import { z } from "zod";

const Id = z.string().trim().min(1).max(240);
export const DesktopCorrectionsRequestSchema = z.object({
  actorId: Id,
  action: z.enum(["read", "choices", "select"]).default("read"),
  datasetId: Id.optional(),
  expectedSelectionRevision: z.number().int().nonnegative().optional(),
}).strict();

export const DesktopCorrectionsStateSchema = z.object({
  scopeKey: z.string().regex(/^[a-f0-9]{64}$/),
  teamId: Id,
  actorId: Id,
  defaultDatasetId: Id,
  selectionRevision: z.number().int().nonnegative(),
  dataset: z.object({ id: Id, name: z.string().min(1).max(500), revision: z.number().int().positive() }).strict().nullable(),
  destinationError: z.string().nullable(),
  graderDraftId: Id,
  graderState: z.enum(["pending", "draft", "unavailable"]),
}).strict();
export type DesktopCorrectionsState = z.infer<typeof DesktopCorrectionsStateSchema>;

export const DesktopCorrectionsChoicesSchema = z.object({
  datasets: z.array(z.object({ id: Id, name: z.string(), revision: z.number().int().positive() }).strict()),
}).strict();
