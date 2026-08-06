import {
  AgentSnapshotSchema,
  HarnessReleaseSchema,
  type AgentSnapshot,
  type HarnessRelease,
} from "@openpond/harness";
import { z } from "zod";

export const LocalHarnessReleaseRecordSchema = z
  .object({
    schemaVersion: z.literal("openpond.localHarnessReleaseRecord.v1"),
    workspaceId: z.string().trim().min(1).max(240),
    sourceRevision: z.string().trim().min(1).max(500),
    agentSnapshot: AgentSnapshotSchema,
    harnessRelease: HarnessReleaseSchema,
    bundlePath: z.string().trim().min(1).max(8_192),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((record, context) => {
    if (
      record.harnessRelease.agentSnapshot.id !== record.agentSnapshot.id ||
      record.harnessRelease.agentSnapshot.contentHash !== record.agentSnapshot.contentHash
    ) {
      context.addIssue({
        code: "custom",
        message: "Harness release must bind the stored Agent snapshot",
        path: ["harnessRelease", "agentSnapshot"],
      });
    }
  });

export type LocalHarnessReleaseRecord = z.infer<typeof LocalHarnessReleaseRecordSchema> & {
  agentSnapshot: AgentSnapshot;
  harnessRelease: HarnessRelease;
};
