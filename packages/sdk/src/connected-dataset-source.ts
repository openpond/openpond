import { z } from "zod";
import { ConnectedSourceKindSchema } from "@openpond/evals/connected-evidence";

/** Activity evidence authorizes recorded evaluation only; no training consent. */
export const ConnectedDatasetSourceRefSchema = z.object({
  schemaVersion: z.literal("openpond.connectedDatasetSource.v1"), kind: z.literal("connected_activity"),
  id: z.string().min(1).max(240), profileId: z.string().min(1).max(240), title: z.string().min(1).max(500),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/), occurredAt: z.string().datetime(),
  licensingStatus: z.enum(["pending", "approved", "review", "blocked"]), secretScanStatus: z.enum(["pending", "passed", "blocked"]),
  piiScanStatus: z.enum(["pending", "passed", "review", "blocked"]),
  origin: ConnectedSourceKindSchema, sourceId: z.string().min(1).max(500), sessionId: z.string().min(1).max(500),
  normalizerVersion: z.string().min(1).max(200), projection: z.enum(["turn", "conversation"]),
  ownerUserId: z.string().min(1).max(500), purpose: z.literal("recorded_evaluation"),
  metadata: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type ConnectedDatasetSourceRef = z.infer<typeof ConnectedDatasetSourceRefSchema>;
