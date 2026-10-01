import { z } from "zod";
import { StandaloneHarnessExperimentSourceSchema } from "@openpond/evals/experiments";
import { OpenPondProfileRefSchema } from "./profile-ref.js";

const Id = z.string().trim().min(1).max(240);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const LocalExperimentSourceChoicesSchema = z.object({
  location: z.literal("local"),
  harnesses: z.array(z.object({ id: Id, name: z.string().max(500), source: StandaloneHarnessExperimentSourceSchema }).strict()).max(100),
  profiles: z.array(z.object({ id: Id, name: z.string().max(500), profileRef: OpenPondProfileRefSchema,
    sourceRevision: z.string().min(1).max(500), harnessRelease: z.object({ id: Id, contentHash: Hash }).strict(),
    definitionId: Id, definitionHash: Hash,
    taskset: z.object({ id: Id, revision:z.number().int().positive(), contentHash: Hash }).strict(), taskCount:z.number().int().nonnegative(),
    taskIds:z.array(Id).max(10_000), seeds:z.array(z.string()).max(10_000),
  }).strict()).max(100),
}).strict();
export type LocalExperimentSourceChoices = z.infer<typeof LocalExperimentSourceChoicesSchema>;
