import { z } from "zod";

import { ImmutableReleaseRefSchema, ReleaseHashSchema } from "./common.js";

const RefinerNoActionDecisionSchema = z
  .object({
    schemaVersion: z.literal("openpond.localHarnessRefinerDecision.v1"),
    decision: z.literal("no_action"),
    reason: z.string().trim().min(1).max(10_000),
  })
  .strip();

const RefinerExternalRouteDecisionSchema = z
  .object({
    schemaVersion: z.literal("openpond.localHarnessRefinerDecision.v1"),
    decision: z.literal("route"),
    route: z.enum(["runtime", "product", "taskset", "training"]),
    summary: z.string().trim().min(1).max(2_000),
    expectedOutcome: z.string().trim().min(1).max(10_000),
    reason: z.string().trim().min(1).max(10_000),
  })
  .strip();

const RefinerProposalDecisionSchema = z
  .object({
    schemaVersion: z.literal("openpond.localHarnessRefinerDecision.v1"),
    decision: z.literal("propose"),
    route: z.enum(["memory", "prompt", "skill", "agent"]),
    operation: z.enum(["create", "update", "delete"]),
    target: z.string().trim().min(1).max(2_000),
    summary: z.string().trim().min(1).max(2_000),
    createContent: z.string().min(1).max(20_000).nullable(),
    find: z.string().min(1).max(8_000).nullable(),
    replace: z.string().max(8_000).nullable(),
    expectedOutcome: z.string().trim().min(1).max(10_000),
    reason: z.string().trim().min(1).max(10_000),
  })
  .strip()
  .superRefine((decision, context) => {
    if (
      decision.operation === "create" &&
      (decision.createContent === null || decision.find !== null || decision.replace !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "create proposals require createContent and null find/replace",
        path: ["createContent"],
      });
    }
    if (
      decision.operation === "update" &&
      (decision.createContent !== null || decision.find === null || decision.replace === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "update proposals require one exact find/replace edit and null createContent",
        path: ["find"],
      });
    }
    if (
      decision.operation === "delete" &&
      (decision.createContent !== null || decision.find !== null || decision.replace !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "delete proposals require null createContent/find/replace",
        path: ["createContent"],
      });
    }
  });

export const LocalHarnessRefinerDecisionSchema = z.discriminatedUnion("decision", [
  RefinerNoActionDecisionSchema,
  RefinerExternalRouteDecisionSchema,
  RefinerProposalDecisionSchema,
]);

export type LocalHarnessRefinerDecision = z.infer<
  typeof LocalHarnessRefinerDecisionSchema
>;

const SourceKindSchema = z.enum(["memory", "instruction", "skill", "agent"]);

export const LocalHarnessRefinerEvidenceSchema = z
  .object({
    trigger: z.record(z.string(), z.unknown()),
    observations: z.array(z.record(z.string(), z.unknown())).max(20),
    task: z
      .object({
        prompt: z.string().max(8_100).nullable(),
        assistantOutput: z.string().max(8_100).nullable(),
        previousAssistantOutput: z.string().max(8_100).nullable(),
      })
      .strict(),
    eventExcerpts: z.array(z.record(z.string(), z.unknown())).max(20),
    sourceFiles: z
      .array(
        z
          .object({
            path: z.string().trim().min(1).max(2_000),
            kind: SourceKindSchema,
            content: z.string().max(60_000),
            loaded: z.boolean(),
          })
          .strict(),
      )
      .max(100),
    sourceCatalog: z
      .array(
        z
          .object({
            path: z.string().trim().min(1).max(2_000),
            kind: SourceKindSchema,
            loaded: z.boolean(),
          })
          .strict(),
      )
      .max(1_000),
  })
  .strict();

export type LocalHarnessRefinerEvidence = z.infer<
  typeof LocalHarnessRefinerEvidenceSchema
>;

const OverlayRefSchema = z
  .object({
    id: z.string().trim().min(1).max(240),
    revision: z.number().int().nonnegative(),
    contentHash: ReleaseHashSchema,
  })
  .strict();

export const HostedHarnessRefinerRequestSchema = z
  .object({
    schemaVersion: z.literal("openpond.hostedHarnessRefinerRequest.v1"),
    requestId: z.string().trim().min(1).max(240),
    idempotencyKey: z.string().trim().min(1).max(240),
    evidenceHash: ReleaseHashSchema,
    harness: z
      .object({
        admittedRelease: ImmutableReleaseRefSchema,
        currentRelease: ImmutableReleaseRefSchema,
        overlay: OverlayRefSchema,
        workspace: z
          .object({
            id: z.string().trim().min(1).max(240),
            revision: z.number().int().nonnegative(),
            sourceRevision: ReleaseHashSchema,
            channelRevision: z.number().int().nonnegative(),
          })
          .strict(),
        capabilities: z
          .object({
            memory: z.boolean(),
            prompt: z.boolean(),
            skill: z.boolean(),
            agent: z.boolean(),
          })
          .strict(),
      })
      .strict(),
    evidence: LocalHarnessRefinerEvidenceSchema,
  })
  .strict();

export type HostedHarnessRefinerRequest = z.infer<
  typeof HostedHarnessRefinerRequestSchema
>;

const HostedHarnessRefinerUsageSchema = z
  .object({
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
  })
  .strict();

export const HostedHarnessRefinerResponseSchema = z
  .object({
    schemaVersion: z.literal("openpond.hostedHarnessRefinerResponse.v1"),
    requestId: z.string().trim().min(1).max(240),
    evidenceHash: ReleaseHashSchema,
    admittedRelease: ImmutableReleaseRefSchema,
    currentRelease: ImmutableReleaseRefSchema,
    decision: LocalHarnessRefinerDecisionSchema,
    serviceRevision: z.string().trim().min(1).max(240),
    usage: HostedHarnessRefinerUsageSchema,
  })
  .strict();

export type HostedHarnessRefinerResponse = z.infer<
  typeof HostedHarnessRefinerResponseSchema
>;

export const DEFAULT_HOSTED_REFINER_TIMEOUT_MS = 60_000;
