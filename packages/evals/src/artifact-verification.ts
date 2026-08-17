import type { ImmutableArtifactRef } from "@openpond/harness";

import {
  ArtifactManifestEntrySchema,
  RewardComponentReceiptSchema,
  type ArtifactManifest,
  type ArtifactManifestEntry,
  type FailureOwner,
  type RewardComponentReceipt,
} from "./execution-contracts.js";
import { createArtifactManifest } from "./execution-receipts.js";
import type { RequiredOutputContract } from "./tasksets.js";

export type CollectedArtifact = {
  path: string;
  artifact: ImmutableArtifactRef | null;
  detectedMediaType: string | null;
  status: "collected" | "failed";
  parseStatus?: "not_requested" | "passed" | "failed";
  schemaStatus?: "not_requested" | "passed" | "failed";
  errorCode?: string | null;
  failureOwner?: "policy" | "collector" | "environment" | null;
  evidenceRefs?: ImmutableArtifactRef[];
  metadata?: Record<string, unknown>;
};

export function buildArtifactManifest(input: {
  id: string;
  attemptRef: { id: string; contentHash: string };
  requiredOutputs: RequiredOutputContract[];
  collectedArtifacts: CollectedArtifact[];
  createdAt: string;
  metadata?: Record<string, unknown>;
}): ArtifactManifest {
  const byPath = new Map<string, CollectedArtifact[]>();
  for (const artifact of input.collectedArtifacts) {
    const matches = byPath.get(artifact.path) ?? [];
    matches.push(artifact);
    byPath.set(artifact.path, matches);
  }
  const consumed = new Set<CollectedArtifact>();
  const entries: ArtifactManifestEntry[] = input.requiredOutputs.map((required) => {
    const matches = byPath.get(required.path) ?? [];
    if (matches.length === 0) {
      return ArtifactManifestEntrySchema.parse({
        requiredOutputPath: required.path,
        collectedPath: null,
        declaredMediaType: required.mediaType,
        detectedMediaType: null,
        artifact: null,
        status: "missing",
        parseStatus: "not_requested",
        schemaStatus: "not_requested",
        errorCode: "required_output_missing",
        failureOwner: "policy",
        evidenceRefs: [],
        metadata: { maxBytes: required.maxBytes, schemaRef: required.schemaRef },
      });
    }
    if (matches.length > 1) {
      for (const match of matches) consumed.add(match);
      return ArtifactManifestEntrySchema.parse({
        requiredOutputPath: required.path,
        collectedPath: required.path,
        declaredMediaType: required.mediaType,
        detectedMediaType: null,
        artifact: null,
        status: "failed",
        parseStatus: "not_requested",
        schemaStatus: "not_requested",
        errorCode: "artifact_collection_ambiguous",
        failureOwner: "collector",
        evidenceRefs: matches.flatMap((match) => match.evidenceRefs ?? []),
        metadata: { duplicateCount: matches.length },
      });
    }
    const [collected] = matches;
    consumed.add(collected!);
    return manifestEntry(required, collected!);
  });
  for (const collected of input.collectedArtifacts) {
    if (consumed.has(collected)) continue;
    entries.push(ArtifactManifestEntrySchema.parse({
      requiredOutputPath: null,
      collectedPath: collected.path,
      declaredMediaType: null,
      detectedMediaType: collected.detectedMediaType,
      artifact: collected.artifact,
      status: collected.status,
      parseStatus: collected.parseStatus ?? "not_requested",
      schemaStatus: collected.schemaStatus ?? "not_requested",
      errorCode: collected.errorCode ?? null,
      failureOwner: collected.failureOwner ?? null,
      evidenceRefs: collected.evidenceRefs ?? [],
      metadata: collected.metadata ?? {},
    }));
  }
  return createArtifactManifest({
    schemaVersion: "openpond.artifactManifest.v1",
    id: input.id,
    attemptRef: input.attemptRef,
    entries,
    createdAt: input.createdAt,
    metadata: input.metadata ?? {},
  });
}

export function verifyRequiredOutputs(input: {
  requiredOutputs: RequiredOutputContract[];
  manifest: ArtifactManifest;
}): RewardComponentReceipt[] {
  return input.requiredOutputs.map((required) => {
    const entry = input.manifest.entries.find(
      (candidate) => candidate.requiredOutputPath === required.path,
    );
    if (!entry || entry.status === "missing") {
      return requiredOutputComponent(required, entry ?? null, {
        status: "scored",
        score: 0,
        passed: false,
        rewardEligible: true,
        failureOwner: "policy",
        feedback: `Required output ${required.path} was not collected.`,
      });
    }
    if (entry.status === "failed" && entry.failureOwner !== "policy") {
      return requiredOutputComponent(required, entry, {
        status: "unscorable",
        score: null,
        passed: false,
        rewardEligible: false,
        failureOwner: entry.failureOwner ?? "collector",
        feedback: `Required output ${required.path} could not be collected reliably.`,
      });
    }
    const failures = structuralFailures(required, entry);
    return requiredOutputComponent(required, entry, {
      status: "scored",
      score: failures.length === 0 ? 1 : 0,
      passed: failures.length === 0,
      rewardEligible: true,
      failureOwner: failures.length === 0 ? null : "policy",
      feedback: failures.length === 0
        ? `Required output ${required.path} passed structural verification.`
        : failures.join(" "),
    });
  });
}

function manifestEntry(
  required: RequiredOutputContract,
  collected: CollectedArtifact,
): ArtifactManifestEntry {
  return ArtifactManifestEntrySchema.parse({
    requiredOutputPath: required.path,
    collectedPath: collected.path,
    declaredMediaType: required.mediaType,
    detectedMediaType: collected.detectedMediaType,
    artifact: collected.artifact,
    status: collected.status,
    parseStatus: collected.parseStatus ?? "not_requested",
    schemaStatus: collected.schemaStatus ?? "not_requested",
    errorCode: collected.errorCode ?? null,
    failureOwner: collected.failureOwner ?? null,
    evidenceRefs: collected.evidenceRefs ?? [],
    metadata: {
      ...collected.metadata,
      maxBytes: required.maxBytes,
      schemaRef: required.schemaRef,
    },
  });
}

function structuralFailures(
  required: RequiredOutputContract,
  entry: ArtifactManifestEntry,
): string[] {
  const failures: string[] = [];
  if (!entry.artifact) failures.push(`Required output ${required.path} has no immutable artifact reference.`);
  if (entry.detectedMediaType !== required.mediaType) {
    failures.push(`Required output ${required.path} has media type ${entry.detectedMediaType ?? "unknown"}; expected ${required.mediaType}.`);
  }
  if (required.maxBytes !== null && entry.artifact?.sizeBytes !== null && entry.artifact && entry.artifact.sizeBytes! > required.maxBytes) {
    failures.push(`Required output ${required.path} exceeds ${required.maxBytes} bytes.`);
  }
  if (entry.parseStatus === "failed") failures.push(`Required output ${required.path} could not be parsed.`);
  if (entry.schemaStatus === "failed") failures.push(`Required output ${required.path} failed schema validation.`);
  return failures;
}

function requiredOutputComponent(
  required: RequiredOutputContract,
  entry: ArtifactManifestEntry | null,
  result: {
    status: "scored" | "unscorable";
    score: number | null;
    passed: boolean;
    rewardEligible: boolean;
    failureOwner: FailureOwner | null;
    feedback: string;
  },
): RewardComponentReceipt {
  const evidenceRefs = [
    ...(entry?.evidenceRefs ?? []),
    ...(entry?.artifact ? [entry.artifact] : []),
  ];
  return RewardComponentReceiptSchema.parse({
    verifierId: `required-output:${required.path}`,
    verifierVersion: "1",
    status: result.status,
    rawScore: result.score,
    normalizedScore: result.score,
    weight: 1,
    passed: result.passed,
    hardGate: true,
    rewardEligible: result.rewardEligible,
    rewardContribution: result.rewardEligible ? result.score : null,
    failureOwner: result.failureOwner,
    feedback: [result.feedback],
    visibleEvidenceRefs: evidenceRefs,
    privilegedEvidenceRefs: [],
    metadata: { requiredOutputPath: required.path },
  });
}
