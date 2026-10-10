import { z } from "zod";
import { DatasetBuildSpecificationSchema } from "./taskset-authored-contracts.js";
import { TasksetSourceRefSchema } from "./taskset-draft-core.js";
import { TaskDesignProposalSchema } from "./task-design-contracts.js";

const Id = z.string().min(1).max(240);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const DatasetPreparationAuthoringEvidenceSchema = z.array(z.object({
  source: TasksetSourceRefSchema,
  excerpts: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(200_000), turnId: Id }).strict()).max(200),
}).strict()).min(1).max(20);
export const DatasetPreparationAuthoringRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("messages"), id: Id, evidence: DatasetPreparationAuthoringEvidenceSchema,
    instruction: z.string().max(100_000), buildSpecification: DatasetBuildSpecificationSchema,
    currentProposal: TaskDesignProposalSchema.nullable().default(null) }).strict(),
  z.object({ action: z.literal("validate"), evidence: DatasetPreparationAuthoringEvidenceSchema,
    content: z.string().max(2 * 1024 * 1024) }).strict(),
]);
export const DatasetPreparationAuthoringMessagesSchema = z.object({
  messages: z.array(z.object({ role: z.enum(["system", "user"]), content: z.string() }).strict()).min(1).max(20),
  skillHash: Hash,
}).strict();
export const DatasetPreparationAuthoringProposalSchema = z.object({ proposal: TaskDesignProposalSchema, skillHash: Hash }).strict();
export type DatasetPreparationAuthoringRequest = z.input<typeof DatasetPreparationAuthoringRequestSchema>;
