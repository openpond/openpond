import { z } from "zod";

export const OpenPondProfileRefSchema = z.object({
  source: z.enum(["local", "github", "openpond_git"]),
  repositoryId: z.string().trim().min(1),
  profileId: z.string().trim().min(1),
});

export type OpenPondProfileRef = z.infer<typeof OpenPondProfileRefSchema>;

export const OpenPondTurnProfileSnapshotSchema = z.object({
  ref: OpenPondProfileRefSchema,
  revision: z.string().nullable(),
  sourceHash: z.string(),
});

export type OpenPondTurnProfileSnapshot = z.infer<typeof OpenPondTurnProfileSnapshotSchema>;
