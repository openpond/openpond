import { z } from "zod";

export const OpenPondActionCatalogEntrySchema = z.object({
  id: z.string().trim().min(1).max(191),
  agentId: z.string().trim().min(1).max(191).optional().nullable(),
  sourcePath: z.string().trim().min(1).max(2000).optional().nullable(),
  sourceActionId: z.string().trim().min(1).max(191).optional().nullable(),
  name: z.string().trim().min(1).max(191).optional().nullable(),
  label: z.string().trim().min(1).max(160).optional().nullable(),
  description: z.string().trim().max(1000).optional().nullable(),
  visibility: z.string().trim().max(80).optional().nullable(),
  inputSchema: z.union([z.string().trim().max(191), z.record(z.string(), z.unknown())]).optional().nullable(),
  outputSchema: z.union([z.string().trim().max(191), z.record(z.string(), z.unknown())]).optional().nullable(),
  approvalPolicy: z.record(z.string(), z.unknown()).optional().nullable(),
  artifactPolicy: z.record(z.string(), z.unknown()).optional().nullable(),
  setupRequirements: z.array(z.record(z.string(), z.unknown())).optional(),
  mcp: z.record(z.string(), z.unknown()).optional().nullable(),
  schedulePolicy: z.record(z.string(), z.unknown()).optional().nullable(),
  trace: z.record(z.string(), z.unknown()).optional().nullable(),
  implementation: z.record(z.string(), z.unknown()).optional().nullable(),
  invokesModel: z.boolean().optional(),
});

export type OpenPondActionCatalogEntry = z.infer<typeof OpenPondActionCatalogEntrySchema>;
