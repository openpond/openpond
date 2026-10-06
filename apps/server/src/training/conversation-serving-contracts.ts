import { z } from "zod";
import { ModelBindingRoleSchema } from "@openpond/contracts";
const id = z.string().trim().min(1).max(240);
export const ConversationServingGrantSchema = z.object({
  id, revision: z.number().int().positive(), ownerInstanceId: id,
  teamId: id, profileId: id, projectId: id, hostedModelId: id,
  role: ModelBindingRoleSchema, roleTargetId: id, expectedBindingId: id,
  policyId: id.nullable(), authorizedConfigurationHash: z.string().length(64).nullable(),
  enabled: z.boolean(), updatedAt: z.string().datetime(),
}).strict();
export type ConversationServingGrant = z.infer<typeof ConversationServingGrantSchema>;
export const ConversationServingExecutionSchema = z.object({
  id, grantId: id, revision: z.number().int().positive(),
  jobId: id, artifactHash: z.string().length(64), priorBindingId: id,
  bindingId: id.nullable(), restoredBindingId: id.nullable(),
  status: z.enum(["prepared", "binding", "canary", "active", "superseded", "rolling_back", "rolled_back", "failed"]),
  leaseId: id, canarySeconds: z.number().int().min(30).max(600),
  activatedAt: z.string().datetime().nullable(), failure: z.string().max(2000).nullable(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict();
export type ConversationServingExecution = z.infer<typeof ConversationServingExecutionSchema>;
