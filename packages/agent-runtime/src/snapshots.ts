import { z } from "zod";

import { canonicalHash } from "./canonical.js";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const AgentEffectiveSurfaceSchema = z.object({
  harnessReleaseHash: HashSchema,
  instructionsHash: HashSchema,
  skillHashes: z.record(z.string(), HashSchema),
  agentAssetHashes: z.record(z.string(), HashSchema),
  toolCatalogHash: HashSchema,
  memoryRevision: z.number().int().nonnegative().nullable()
}).strict();

export const AgentCheckpointSchema = z.object({
  protocolVersion: z.string().trim().min(1),
  threadId: z.string().trim().min(1),
  turnId: z.string().trim().min(1),
  harnessReleaseHash: HashSchema,
  toolCatalogHash: HashSchema,
  context: z.record(z.string(), z.unknown()),
  pendingInteraction: z.record(z.string(), z.unknown()).nullable(),
  usage: z.record(z.string(), z.unknown())
}).strict();

export type AgentEffectiveSurface = z.infer<typeof AgentEffectiveSurfaceSchema>;
export type AgentCheckpoint = z.infer<typeof AgentCheckpointSchema>;

export function effectiveSurfaceHash(surface: AgentEffectiveSurface): string {
  return canonicalHash(AgentEffectiveSurfaceSchema.parse(surface));
}

export function checkpointHash(checkpoint: AgentCheckpoint): string {
  return canonicalHash(AgentCheckpointSchema.parse(checkpoint));
}

export function materializeAgentPrompt(input: {
  system: string;
  harnessInstructions: readonly string[];
  skillInstructions: readonly string[];
  hostInstructions?: readonly string[];
}): string {
  return [
    input.system,
    ...input.harnessInstructions,
    ...input.skillInstructions,
    ...(input.hostInstructions ?? [])
  ].map((part) => part.trim()).filter(Boolean).join("\n\n");
}
