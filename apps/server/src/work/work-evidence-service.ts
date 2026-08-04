import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { contentHash, sha256, type ImmutableReleaseRef } from "@openpond/evals";
import {
  createWorkFeedbackReceipt,
  workEvidenceReceiptRef,
  type EvidenceArtifactRef,
  type WorkFeedbackReasonCode,
  type WorkFeedbackVerdict,
} from "@openpond/evals/evidence";

import type { SqliteStore } from "../store/store.js";
import type {
  LocalWorkEvidenceArtifact,
  StoredWorkEvidenceProjection,
  StoredWorkFeedback,
} from "../store/store-work-evidence.js";
import {
  projectDesktopWorkEvidence,
  type DesktopWorkEvidenceConsent,
} from "./desktop-work-evidence-projector.js";
import { createWorkEvidenceArtifactStore } from "./work-evidence-artifact-store.js";

export async function captureDesktopWorkEvidence(input: {
  store: SqliteStore;
  storeDir: string;
  sessionId: string;
  turnId: string;
  consent: DesktopWorkEvidenceConsent;
  agentSnapshot?: ImmutableReleaseRef | null;
  now?: () => string;
}): Promise<StoredWorkEvidenceProjection> {
  const [session, turn, runtimeEvents, usageRecords] = await Promise.all([
    input.store.getSession(input.sessionId),
    input.store.getTurn(input.turnId),
    input.store.runtimeEventsForSession(input.sessionId, { limit: 100_000 }),
    input.store.listModelUsageRecords({ turnId: input.turnId, limit: 10_000 }),
  ]);
  if (!session) throw new Error("Work evidence session was not found.");
  if (!turn) throw new Error("Work evidence turn was not found.");
  const createdAt = (input.now ?? (() => new Date().toISOString()))();
  const projection = projectDesktopWorkEvidence({
    session,
    turn,
    runtimeEvents,
    usageRecords,
    consent: input.consent,
    agentSnapshot: input.agentSnapshot,
    projectedAt: createdAt,
  });
  const existing = await input.store.getWorkEvidenceProjectionBySourceRevision(
    projection.sourceRevisionHash,
  );
  if (existing) return existing;

  const artifacts = createWorkEvidenceArtifactStore(input.storeDir);
  const persisted: LocalWorkEvidenceArtifact[] = [];
  persisted.push(await artifacts.persistPrivateJson({
    kind: "private_trace",
    value: projection.privateTrace,
  }));
  persisted.push(await artifacts.persistPortableJson({
    kind: "consent_receipt",
    value: projection.consentArtifact.value,
    semanticHash: projection.consentArtifact.ref.contentHash,
    mediaType: projection.consentArtifact.ref.mediaType!,
  }));
  for (const validation of projection.validationArtifacts) {
    persisted.push(await artifacts.persistPortableJson({
      kind: "validation_evidence",
      value: validation.value,
      semanticHash: validation.ref.contentHash,
      mediaType: validation.ref.mediaType!,
    }));
  }
  for (const output of projection.outputArtifacts) {
    persisted.push(await artifacts.persistPortableJson({
      kind: "output_revision",
      value: output.revisionDescriptor,
      semanticHash: output.revisionRef.contentHash,
      mediaType: output.revisionRef.mediaType!,
    }));
    if (output.output.location.kind === "local") {
      await verifyManagedOutput({
        storeDir: input.storeDir,
        path: output.output.location.path,
        expectedHash: output.output.sha256,
        expectedSizeBytes: output.output.sizeBytes,
      });
      persisted.push(artifacts.existingOutputArtifact({
        ref: output.contentRef,
        path: output.output.location.path,
      }));
    }
  }
  persisted.push(await artifacts.persistPortableJson({
    kind: "sanitized_trace",
    value: projection.sanitizedTrace,
    semanticHash: projection.sanitizedTrace.contentHash,
    mediaType: "application/vnd.openpond.work-process-trace+json",
  }));
  persisted.push(await artifacts.persistPortableJson({
    kind: "evidence_receipt",
    value: projection.receipt,
    semanticHash: projection.receipt.contentHash,
    mediaType: "application/vnd.openpond.work-evidence+json",
  }));
  return input.store.saveWorkEvidenceProjection({
    schemaVersion: "openpond.storedWorkEvidenceProjection.v1",
    sourceSessionId: session.id,
    sourceTurnId: turn.id,
    sourceRevisionHash: projection.sourceRevisionHash,
    receipt: projection.receipt,
    trace: projection.sanitizedTrace,
    artifacts: persisted,
    createdAt,
  });
}

export async function recordDesktopWorkFeedback(input: {
  store: SqliteStore;
  storeDir: string;
  evidenceReceiptId: string;
  outputRevisionHash?: string | null;
  verdict: WorkFeedbackVerdict;
  reasonCodes?: WorkFeedbackReasonCode[];
  correction?: string | Uint8Array | null;
  correctionMediaType?: string;
  correctedOutputRevisionRef?: EvidenceArtifactRef | null;
  now?: () => string;
}): Promise<StoredWorkFeedback> {
  const evidence = await input.store.getWorkEvidenceProjection(input.evidenceReceiptId);
  if (!evidence) throw new Error("Work evidence receipt was not found.");
  const outputRevisionRef = input.outputRevisionHash
    ? evidence.receipt.outputRefs.find((output) => output.contentHash === input.outputRevisionHash) ?? null
    : null;
  if (input.outputRevisionHash && !outputRevisionRef) {
    throw new Error("Work output revision was not found on the evidence receipt.");
  }
  const artifacts = createWorkEvidenceArtifactStore(input.storeDir);
  const persisted: LocalWorkEvidenceArtifact[] = [];
  let correctionRef: EvidenceArtifactRef | null = null;
  if (input.correction !== undefined && input.correction !== null) {
    if (input.verdict !== "needs_correction") {
      throw new Error("Correction content requires needs_correction feedback.");
    }
    const correction = typeof input.correction === "string"
      ? new TextEncoder().encode(input.correction)
      : input.correction;
    const artifact = await artifacts.persistPrivateBytes({
      kind: "correction",
      bytes: correction,
      mediaType: input.correctionMediaType ?? "text/plain",
    });
    persisted.push(artifact);
    correctionRef = artifact.ref;
  }
  const createdAt = (input.now ?? (() => new Date().toISOString()))();
  const receiptId = `work-feedback-${contentHash([
    evidence.receipt.contentHash,
    outputRevisionRef?.contentHash ?? null,
    input.verdict,
    input.reasonCodes ?? [],
    correctionRef?.contentHash ?? null,
    input.correctedOutputRevisionRef?.contentHash ?? null,
    createdAt,
  ]).slice(0, 24)}`;
  const receipt = createWorkFeedbackReceipt({
    schemaVersion: "openpond.workFeedbackReceipt.v1",
    id: receiptId,
    evidenceReceiptRef: workEvidenceReceiptRef(evidence.receipt),
    outputRevisionRef,
    verdict: input.verdict,
    reasonCodes: input.reasonCodes ?? [],
    correctionRef,
    correctedOutputRevisionRef: input.correctedOutputRevisionRef ?? null,
    actor: "user",
    createdAt,
  }, evidence.receipt);
  persisted.push(await artifacts.persistPortableJson({
    kind: "feedback_receipt",
    value: receipt,
    semanticHash: receipt.contentHash,
    mediaType: "application/vnd.openpond.work-feedback+json",
  }));
  return input.store.saveWorkFeedback({
    schemaVersion: "openpond.storedWorkFeedback.v1",
    receipt,
    artifacts: persisted,
    createdAt,
  });
}

async function verifyManagedOutput(input: {
  storeDir: string;
  path: string;
  expectedHash: string;
  expectedSizeBytes: number;
}): Promise<void> {
  const outputRoot = path.resolve(input.storeDir, "work", "outputs");
  const target = path.resolve(input.path);
  if (!target.startsWith(`${outputRoot}${path.sep}`)) {
    throw new Error("Work evidence output is outside managed local output storage.");
  }
  const info = await stat(target);
  if (!info.isFile() || info.size !== input.expectedSizeBytes) {
    throw new Error("Work evidence output size changed before projection.");
  }
  const bytes = await readFile(target);
  if (sha256(bytes) !== input.expectedHash) {
    throw new Error("Work evidence output hash changed before projection.");
  }
}
