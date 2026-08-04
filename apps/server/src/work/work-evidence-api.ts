import { ImmutableReleaseRefSchema } from "@openpond/evals";
import {
  EvidenceArtifactRefSchema,
  WorkEvidencePolicyStateSchema,
  WorkFeedbackReasonCodeSchema,
  WorkFeedbackVerdictSchema,
  classifyWorkEvidence,
} from "@openpond/evals/evidence";
import { AttemptReceiptSchema } from "@openpond/evals/runs";
import { z } from "zod";

import type { SqliteStore } from "../store/store.js";
import { DesktopWorkEvidenceConsentSchema } from "./desktop-work-evidence-projector.js";
import {
  captureDesktopWorkEvidence,
  recordDesktopWorkFeedback,
} from "./work-evidence-service.js";

const CaptureDesktopWorkEvidenceRequestSchema = z.object({
  sessionId: z.string().trim().min(1).max(1_000),
  turnId: z.string().trim().min(1).max(1_000),
  consent: DesktopWorkEvidenceConsentSchema,
  agentSnapshot: ImmutableReleaseRefSchema.nullable().optional(),
}).strict();

const RecordDesktopWorkFeedbackRequestSchema = z.object({
  outputRevisionHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  verdict: WorkFeedbackVerdictSchema,
  reasonCodes: z.array(WorkFeedbackReasonCodeSchema).max(16).optional(),
  correction: z.string().max(1_000_000).nullable().optional(),
  correctionMediaType: z.string().trim().min(1).max(200).optional(),
  correctedOutputRevisionRef: EvidenceArtifactRefSchema.nullable().optional(),
}).strict();

const WorkEvidenceEligibilityRequestSchema = z.object({
  policyState: WorkEvidencePolicyStateSchema,
  reconstructability: z.object({
    input: z.boolean(),
    environment: z.boolean(),
    verifier: z.boolean(),
  }).strict(),
  replay: z.object({
    attemptReceipt: AttemptReceiptSchema,
    sourceEvidenceReceiptHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().nullable().optional(),
}).strict();

export function createDesktopWorkEvidenceApi(input: {
  store: SqliteStore;
  storeDir: string;
  now?: () => string;
}) {
  return {
    async capture(payload: unknown) {
      const request = CaptureDesktopWorkEvidenceRequestSchema.parse(payload);
      const stored = await captureDesktopWorkEvidence({
        store: input.store,
        storeDir: input.storeDir,
        sessionId: request.sessionId,
        turnId: request.turnId,
        consent: request.consent,
        agentSnapshot: request.agentSnapshot,
        now: input.now,
      });
      return publicEvidence(stored);
    },

    async get(receiptId: string) {
      const stored = await requiredEvidence(input.store, receiptId);
      return publicEvidence(stored);
    },

    async recordFeedback(receiptId: string, payload: unknown) {
      const request = RecordDesktopWorkFeedbackRequestSchema.parse(payload);
      const stored = await recordDesktopWorkFeedback({
        store: input.store,
        storeDir: input.storeDir,
        evidenceReceiptId: receiptId,
        outputRevisionHash: request.outputRevisionHash,
        verdict: request.verdict,
        reasonCodes: request.reasonCodes,
        correction: request.correction,
        correctionMediaType: request.correctionMediaType,
        correctedOutputRevisionRef: request.correctedOutputRevisionRef,
        now: input.now,
      });
      return publicFeedback(stored);
    },

    async listFeedback(receiptId: string) {
      const evidence = await requiredEvidence(input.store, receiptId);
      const feedback = await input.store.listWorkFeedbackForEvidence(evidence.receipt);
      return { feedback: feedback.map(publicFeedback) };
    },

    async eligibility(receiptId: string, payload: unknown) {
      const request = WorkEvidenceEligibilityRequestSchema.parse(payload);
      const evidence = await requiredEvidence(input.store, receiptId);
      const feedback = await input.store.listWorkFeedbackForEvidence(evidence.receipt);
      return {
        eligibility: classifyWorkEvidence({
          evidence: evidence.receipt,
          feedback: feedback.map((item) => item.receipt),
          policyState: request.policyState,
          reconstructability: request.reconstructability,
          replay: request.replay ?? null,
        }),
      };
    },
  };
}

async function requiredEvidence(store: SqliteStore, receiptId: string) {
  const evidence = await store.getWorkEvidenceProjection(receiptId);
  if (!evidence) throw new Error("Work evidence receipt was not found.");
  return evidence;
}

function publicEvidence(stored: Awaited<ReturnType<typeof requiredEvidence>>) {
  return {
    evidence: {
      receipt: stored.receipt,
      trace: stored.trace,
      createdAt: stored.createdAt,
    },
  };
}

function publicFeedback(stored: Awaited<ReturnType<SqliteStore["saveWorkFeedback"]>>) {
  return {
    receipt: stored.receipt,
    createdAt: stored.createdAt,
  };
}
