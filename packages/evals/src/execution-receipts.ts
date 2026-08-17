import { contentHash } from "@openpond/harness";
import type { FailureClass, ImmutableArtifactRef } from "@openpond/harness";

import {
  ArtifactManifestContentSchema,
  ArtifactManifestSchema,
  EnvironmentReleaseContentSchema,
  EnvironmentReleaseSchema,
  RewardComponentReceiptSchema,
  RewardReceiptContentSchema,
  RewardReceiptSchema,
  VerifierSetReleaseContentSchema,
  VerifierSetReleaseSchema,
  type ArtifactManifest,
  type AttemptOutcomeClass,
  type EnvironmentRelease,
  type FailureOwner,
  type RewardComponentReceipt,
  type RewardReceipt,
  type VerifierSetRelease,
} from "./execution-contracts.js";
import {
  TasksetReleaseContentSchema,
  TasksetReleaseSchema,
  type TasksetRelease,
} from "./tasksets.js";

export function createEnvironmentRelease(
  input: Parameters<typeof EnvironmentReleaseContentSchema.parse>[0],
): EnvironmentRelease {
  const content = EnvironmentReleaseContentSchema.parse(input);
  return EnvironmentReleaseSchema.parse({ ...content, contentHash: contentHash(content) });
}

export function createArtifactManifest(
  input: Parameters<typeof ArtifactManifestContentSchema.parse>[0],
): ArtifactManifest {
  const content = ArtifactManifestContentSchema.parse(input);
  return ArtifactManifestSchema.parse({ ...content, contentHash: contentHash(content) });
}

export function createVerifierSetRelease(
  input: Parameters<typeof VerifierSetReleaseContentSchema.parse>[0],
): VerifierSetRelease {
  const content = VerifierSetReleaseContentSchema.parse(input);
  return VerifierSetReleaseSchema.parse({ ...content, contentHash: contentHash(content) });
}

export function bindTasksetExecutionReleases(input: {
  taskset: TasksetRelease;
  environment: EnvironmentRelease;
  verifierSet: VerifierSetRelease;
}): TasksetRelease {
  verifyContentHash(input.environment, EnvironmentReleaseContentSchema, "Environment Release");
  verifyContentHash(input.verifierSet, VerifierSetReleaseContentSchema, "Verifier Set Release");
  if (contentHash(input.taskset.environment) !== contentHash(input.environment.contract)) {
    throw new Error("Environment Release does not match the Taskset execution contract.");
  }
  if (contentHash(input.taskset.graders) !== contentHash(input.verifierSet.graders)) {
    throw new Error("Verifier Set Release does not match the Taskset graders.");
  }
  const { contentHash: _previousHash, ...previousContent } = input.taskset;
  const content = TasksetReleaseContentSchema.parse({
    ...previousContent,
    environmentRelease: {
      id: input.environment.id,
      contentHash: input.environment.contentHash,
    },
    verifierSetRelease: {
      id: input.verifierSet.id,
      contentHash: input.verifierSet.contentHash,
    },
  });
  return TasksetReleaseSchema.parse({ ...content, contentHash: contentHash(content) });
}

export function classifyAttemptOutcome(input: {
  failureClass: FailureClass | null;
  timeoutKind?: "task_deadline" | "infrastructure_timeout";
}): { outcomeClass: AttemptOutcomeClass; failureOwner: FailureOwner | null } {
  switch (input.failureClass) {
    case null:
      return { outcomeClass: "completed", failureOwner: null };
    case "policy_failure":
      return { outcomeClass: "policy_failure", failureOwner: "policy" };
    case "environment_failure":
      return { outcomeClass: "environment_failure", failureOwner: "environment" };
    case "grader_failure":
      return { outcomeClass: "verifier_failure", failureOwner: "verifier" };
    case "infrastructure_failure":
      return { outcomeClass: "host_failure", failureOwner: "host" };
    case "cancelled":
      return { outcomeClass: "cancelled", failureOwner: "user" };
    case "timeout":
      return input.timeoutKind === "task_deadline"
        ? { outcomeClass: "task_deadline", failureOwner: "policy" }
        : { outcomeClass: "infrastructure_timeout", failureOwner: "host" };
  }
}

export function createRewardReceipt(input: {
  id: string;
  attemptRef: { id: string; contentHash: string };
  verifierSet: VerifierSetRelease;
  artifactManifest: ArtifactManifest;
  outcomeClass: AttemptOutcomeClass;
  failureOwner: FailureOwner | null;
  components: RewardComponentReceipt[];
  visibleEvidenceRefs?: ImmutableArtifactRef[];
  privilegedEvidenceRefs?: ImmutableArtifactRef[];
  supersedes?: { id: string; contentHash: string } | null;
  createdAt: string;
  metadata?: Record<string, unknown>;
}): RewardReceipt {
  verifyContentHash(input.verifierSet, VerifierSetReleaseContentSchema, "Verifier Set Release");
  verifyContentHash(input.artifactManifest, ArtifactManifestContentSchema, "Artifact Manifest");
  if (
    input.artifactManifest.attemptRef.id !== input.attemptRef.id
    || input.artifactManifest.attemptRef.contentHash !== input.attemptRef.contentHash
  ) {
    throw new Error("Artifact Manifest does not belong to the Reward Receipt Attempt.");
  }
  const outcomeScorable = isScorableOutcome(input.outcomeClass);
  const components = input.components.map((raw) => {
    const component = RewardComponentReceiptSchema.parse(raw);
    const rewardEligible = outcomeScorable
      && component.status === "scored"
      && component.normalizedScore !== null
      && component.rewardEligible;
    return RewardComponentReceiptSchema.parse({
      ...component,
      rewardEligible,
      rewardContribution: rewardEligible ? component.normalizedScore : null,
    });
  });
  const eligible = components.filter(
    (component) => component.rewardEligible && component.normalizedScore !== null,
  );
  const status = eligible.length > 0 ? "scored" as const : "unscorable" as const;
  const hardGateFailed = eligible.some((component) => component.hardGate && !component.passed);
  const totalWeight = eligible.reduce((total, component) => total + component.weight, 0);
  const weightedReward = totalWeight > 0
    ? eligible.reduce(
      (total, component) => total + component.normalizedScore! * component.weight,
      0,
    ) / totalWeight
    : 0;
  const reward = status === "scored" ? hardGateFailed ? 0 : weightedReward : null;
  const passed = status === "scored" && eligible.every((component) => component.passed);
  const content = RewardReceiptContentSchema.parse({
    schemaVersion: "openpond.rewardReceipt.v1",
    id: input.id,
    attemptRef: input.attemptRef,
    verifierSetRef: {
      id: input.verifierSet.id,
      contentHash: input.verifierSet.contentHash,
    },
    artifactManifestRef: {
      id: input.artifactManifest.id,
      contentHash: input.artifactManifest.contentHash,
    },
    status,
    reward,
    learningEligible: status === "scored",
    passed,
    outcomeClass: input.outcomeClass,
    failureOwner: input.failureOwner,
    components,
    visibleEvidenceRefs: uniqueArtifactRefs([
      ...(input.visibleEvidenceRefs ?? []),
      ...components.flatMap((component) => component.visibleEvidenceRefs),
    ]),
    privilegedEvidenceRefs: uniqueArtifactRefs([
      ...(input.privilegedEvidenceRefs ?? []),
      ...components.flatMap((component) => component.privilegedEvidenceRefs),
    ]),
    supersedes: input.supersedes ?? null,
    createdAt: input.createdAt,
    metadata: input.metadata ?? {},
  });
  return RewardReceiptSchema.parse({ ...content, contentHash: contentHash(content) });
}

export function regradeRewardReceipt(input: {
  original: RewardReceipt;
  id: string;
  verifierSet: VerifierSetRelease;
  artifactManifest: ArtifactManifest;
  components: RewardComponentReceipt[];
  outcomeClass?: AttemptOutcomeClass;
  failureOwner?: FailureOwner | null;
  createdAt: string;
  metadata?: Record<string, unknown>;
}): RewardReceipt {
  if (!verifyRewardReceipt(input.original)) {
    throw new Error("Cannot regrade an invalid Reward Receipt.");
  }
  return createRewardReceipt({
    id: input.id,
    attemptRef: input.original.attemptRef,
    verifierSet: input.verifierSet,
    artifactManifest: input.artifactManifest,
    outcomeClass: input.outcomeClass ?? input.original.outcomeClass,
    failureOwner: input.failureOwner === undefined
      ? input.original.failureOwner
      : input.failureOwner,
    components: input.components,
    supersedes: {
      id: input.original.id,
      contentHash: input.original.contentHash,
    },
    createdAt: input.createdAt,
    metadata: {
      ...input.metadata,
      regradeOf: input.original.id,
    },
  });
}

export function verifyEnvironmentRelease(release: EnvironmentRelease): boolean {
  return hasValidContentHash(release, EnvironmentReleaseContentSchema);
}

export function verifyArtifactManifest(manifest: ArtifactManifest): boolean {
  return hasValidContentHash(manifest, ArtifactManifestContentSchema);
}

export function verifyVerifierSetRelease(release: VerifierSetRelease): boolean {
  return hasValidContentHash(release, VerifierSetReleaseContentSchema);
}

export function verifyRewardReceipt(receipt: RewardReceipt): boolean {
  const parsed = RewardReceiptSchema.safeParse(receipt);
  if (!parsed.success) return false;
  const { contentHash: actual, ...content } = parsed.data;
  return contentHash(RewardReceiptContentSchema.parse(content)) === actual;
}

export function isScorableOutcome(outcome: AttemptOutcomeClass): boolean {
  return outcome === "completed"
    || outcome === "policy_failure"
    || outcome === "incomplete_output"
    || outcome === "task_deadline";
}

function uniqueArtifactRefs(refs: ImmutableArtifactRef[]): ImmutableArtifactRef[] {
  return [...new Map(refs.map((ref) => [`${ref.id}:${ref.contentHash}`, ref])).values()];
}

function verifyContentHash<T extends Record<string, unknown>>(
  value: T & { contentHash: string },
  schema: { parse(input: unknown): unknown },
  label: string,
): void {
  const { contentHash: actual, ...content } = value;
  const expected = contentHash(schema.parse(content));
  if (actual !== expected) throw new Error(`${label} content hash mismatch.`);
}

function hasValidContentHash<T extends Record<string, unknown>>(
  value: T & { contentHash: string },
  schema: { parse(input: unknown): unknown },
): boolean {
  try {
    verifyContentHash(value, schema, "Receipt");
    return true;
  } catch {
    return false;
  }
}
