import { z } from "zod";
import {
  CreatePipelineRequestSchema,
  CreatePipelineSnapshotSchema,
} from "./create-pipeline.js";
import { ChatProviderSchema, WorkspaceKindSchema } from "./settings.js";
import { ChatModelRefSchema } from "./providers.js";

export const SessionSchema = z.object({
  id: z.string(),
  provider: ChatProviderSchema,
  modelRef: ChatModelRefSchema.nullable().optional(),
  systemKind: z.enum(["openpond.insights"]).nullable().optional(),
  hiddenFromDefaultSidebar: z.boolean().optional(),
  title: z.string(),
  appId: z.string().nullable(),
  appName: z.string().nullable(),
  workspaceKind: WorkspaceKindSchema.optional(),
  workspaceId: z.string().nullable().optional(),
  workspaceName: z.string().nullable().optional(),
  localProjectId: z.string().nullable().optional(),
  cloudProjectId: z.string().nullable().optional(),
  cloudTeamId: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  cwd: z.string().nullable(),
  codexThreadId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  status: z.enum(["idle", "active", "failed", "closed"]),
  pinned: z.boolean(),
  archived: z.boolean(),
  order: z.number(),
});

export type Session = z.infer<typeof SessionSchema>;

export const TurnSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  providerTurnId: z.string().nullable(),
  modelRef: ChatModelRefSchema.nullable().optional(),
  prompt: z.string(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  status: z.enum(["in_progress", "completed", "failed", "interrupted"]),
  error: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
  createPipelineRequest: CreatePipelineRequestSchema.nullable().optional().default(null),
  createPipeline: CreatePipelineSnapshotSchema.nullable().optional().default(null),
});

export type Turn = z.infer<typeof TurnSchema>;
