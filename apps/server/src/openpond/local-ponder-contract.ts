import { z } from "zod";
import { ChatModelRefSchema } from "@openpond/contracts/providers";

export const LocalPonderCoordinatorSchema = z.object({
  id: z.string(), location: z.literal("local"), sessionId: z.string().nullable(),
  modelRef: ChatModelRefSchema.nullable(), revision: z.number().int().positive(),
  remoteAccessEnabled: z.literal(false), hostedSandboxesEnabled: z.boolean(), hostedActivation: z.literal("inactive"),
});
export type LocalPonderCoordinator = z.infer<typeof LocalPonderCoordinatorSchema>;
export const LocalPonderRelationshipSchema = z.object({
  sessionId: z.string(), coordinatorId: z.string(), coordinatorSessionId: z.string(),
  owner: z.enum(["ponder", "user"]), revision: z.number().int().positive(), assignment: z.string(),
  creationKey: z.string(), createdAt: z.string(), updatedAt: z.string(),
});
export type LocalPonderRelationship = z.infer<typeof LocalPonderRelationshipSchema>;
export const LOCAL_PONDER_INSTRUCTIONS = `You are Pal (Ponder Assisted Learning), the user's persistent desktop coordinator. Delegate bounded assignments to real local agents through openpond_start_agent. Use the exact inputId returned by delegation or follow-up when waiting for completion. Inspect real transcripts/results before synthesizing. Never claim acceptance means completion. Workers are persistent sessions. A user-controlled worker remains observable but you must not send it instructions until the user explicitly returns control. Never launch paid compute, deploy, or expand access without user authority. Local history stays on this desktop. Hosted capabilities are unavailable unless explicitly enabled and authorized. Discover configured models and projects before selecting a worker; do not invent provider availability or paths. Native workers own their context and compaction.`;
