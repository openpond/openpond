import {
  DatasetReleaseContentSchema,
  DatasetReleaseSchema,
  EvidenceSetReleaseContentSchema,
  EvidenceSetReleaseSchema,
  HarnessReleaseContentSchema,
  HarnessReleaseSchema,
  HarnessRunManifestContentSchema,
  HarnessRunManifestSchema,
  type EvidenceSetRelease,
  type DatasetRelease,
  type HarnessRelease,
  type HarnessRunManifest,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";

export type ReleaseGraphIssue = {
  code: string;
  path: string;
  message: string;
};

const REQUIRED_HARNESS_CHILDREN = [
  "program",
  "tool_contract",
  "runtime_spec",
  "grader_definition",
  "feedback_policy",
  "dependency_lock",
  "extension_lock",
] as const;

export function publishHarnessRelease(
  input: Omit<HarnessRelease, "contentHash">,
): HarnessRelease {
  const content = HarnessReleaseContentSchema.parse(input);
  const release = HarnessReleaseSchema.parse({
    ...content,
    contentHash: contentHash(content),
  });
  const issues = validateHarnessRelease(release);
  if (issues.length) throw releaseGraphError("Harness Release", issues);
  return release;
}

export function publishDatasetRelease(
  input: Omit<DatasetRelease, "contentHash">,
): DatasetRelease {
  const content = DatasetReleaseContentSchema.parse(input);
  const release = DatasetReleaseSchema.parse({
    ...content,
    contentHash: contentHash(content),
  });
  const issues = validateDatasetRelease(release);
  if (issues.length) throw releaseGraphError("Dataset Release", issues);
  return release;
}

export function publishEvidenceSetRelease(
  input: Omit<EvidenceSetRelease, "contentHash">,
): EvidenceSetRelease {
  const content = EvidenceSetReleaseContentSchema.parse(input);
  const release = EvidenceSetReleaseSchema.parse({
    ...content,
    contentHash: contentHash(content),
  });
  const issues = validateEvidenceSetRelease(release);
  if (issues.length) throw releaseGraphError("Evidence Set Release", issues);
  return release;
}

export function createHarnessRunManifest(
  input: Omit<HarnessRunManifest, "contentHash">,
): HarnessRunManifest {
  const content = HarnessRunManifestContentSchema.parse(input);
  const manifest = HarnessRunManifestSchema.parse({
    ...content,
    contentHash: contentHash(content),
  });
  const issues = validateHarnessRunManifest(manifest);
  if (issues.length) throw releaseGraphError("Harness Run Manifest", issues);
  return manifest;
}

export function validateHarnessRelease(
  release: HarnessRelease,
): ReleaseGraphIssue[] {
  const issues: ReleaseGraphIssue[] = [];
  const { contentHash: releaseHash, ...content } = release;
  if (contentHash(content) !== releaseHash) {
    issues.push({
      code: "release_hash_mismatch",
      path: "contentHash",
      message: "Harness Release content hash does not match its canonical content.",
    });
  }
  const childrenByKind = new Map<string, number>();
  const childIds = new Set<string>();
  for (const [index, child] of release.children.entries()) {
    childrenByKind.set(child.kind, (childrenByKind.get(child.kind) ?? 0) + 1);
    const identity = `${child.kind}:${child.id}`;
    if (childIds.has(identity)) {
      issues.push({
        code: "duplicate_child_release",
        path: `children.${index}`,
        message: `Harness child ${identity} is duplicated.`,
      });
    }
    childIds.add(identity);
  }
  for (const kind of REQUIRED_HARNESS_CHILDREN) {
    if (!childrenByKind.has(kind)) {
      issues.push({
        code: "required_child_missing",
        path: "children",
        message: `Harness Release is missing its ${kind} child release.`,
      });
    }
  }
  const assetPaths = new Set<string>();
  for (const [index, asset] of release.assets.entries()) {
    if (!safeRelativePath(asset.path)) {
      issues.push({
        code: "asset_path_invalid",
        path: `assets.${index}.path`,
        message: `Harness asset ${asset.path} must be a normalized relative path.`,
      });
    }
    if (assetPaths.has(asset.path)) {
      issues.push({
        code: "duplicate_asset_path",
        path: `assets.${index}.path`,
        message: `Harness asset path ${asset.path} is duplicated.`,
      });
    }
    assetPaths.add(asset.path);
    if (
      asset.visibility === "privileged" &&
      asset.projections.includes("student")
    ) {
      issues.push({
        code: "privileged_asset_student_visible",
        path: `assets.${index}.projections`,
        message: "Privileged assets cannot enter the student projection.",
      });
    }
  }
  const secretIds = new Set<string>();
  for (const [index, secret] of release.secretDeclarations.entries()) {
    if (secretIds.has(secret.id)) {
      issues.push({
        code: "duplicate_secret_declaration",
        path: `secretDeclarations.${index}.id`,
        message: `Secret declaration ${secret.id} is duplicated.`,
      });
    }
    secretIds.add(secret.id);
  }
  const actionIds = new Set<string>();
  const modelToolNames = new Set<string>();
  for (const [index, binding] of (release.actionBindings ?? []).entries()) {
    if (actionIds.has(binding.actionId)) {
      issues.push({
        code: "duplicate_action_binding",
        path: `actionBindings.${index}.actionId`,
        message: `Harness action ${binding.actionId} is bound more than once.`,
      });
    }
    actionIds.add(binding.actionId);
    if (modelToolNames.has(binding.modelToolName)) {
      issues.push({
        code: "duplicate_model_tool_name",
        path: `actionBindings.${index}.modelToolName`,
        message: `Harness model tool ${binding.modelToolName} is bound more than once.`,
      });
    }
    modelToolNames.add(binding.modelToolName);
    if (contentHash(binding.inputSchema) !== binding.actionSchemaHash) {
      issues.push({
        code: "action_schema_hash_mismatch",
        path: `actionBindings.${index}.actionSchemaHash`,
        message: `Harness action ${binding.actionId} input schema does not match its pinned hash.`,
      });
    }
  }
  return issues;
}

export function validateEvidenceSetRelease(
  release: EvidenceSetRelease,
): ReleaseGraphIssue[] {
  const issues: ReleaseGraphIssue[] = [];
  const { contentHash: releaseHash, ...content } = release;
  if (contentHash(content) !== releaseHash) {
    issues.push({
      code: "release_hash_mismatch",
      path: "contentHash",
      message: "Evidence Set Release content hash does not match its canonical content.",
    });
  }
  const signalIds = new Set<string>();
  for (const [index, signal] of release.signals.entries()) {
    if (signalIds.has(signal.id)) {
      issues.push({
        code: "duplicate_signal",
        path: `signals.${index}.id`,
        message: `Evidence signal ${signal.id} is duplicated.`,
      });
    }
    signalIds.add(signal.id);
    if (!signal.approved) {
      issues.push({
        code: "unapproved_signal",
        path: `signals.${index}.approved`,
        message: "Published Evidence Set Releases contain only approved signals.",
      });
    }
  }
  return issues;
}

export function validateDatasetRelease(
  release: DatasetRelease,
): ReleaseGraphIssue[] {
  const issues: ReleaseGraphIssue[] = [];
  const { contentHash: releaseHash, ...content } = release;
  if (contentHash(content) !== releaseHash) {
    issues.push({
      code: "release_hash_mismatch",
      path: "contentHash",
      message:
        "Dataset Release content hash does not match its canonical content.",
    });
  }
  const paths = new Set<string>();
  const splitCounts = { train: 0, frozen_eval: 0 };
  for (const [index, asset] of release.assets.entries()) {
    if (!safeRelativePath(asset.path)) {
      issues.push({
        code: "asset_path_invalid",
        path: `assets.${index}.path`,
        message: `Dataset asset ${asset.path} must be a normalized relative path.`,
      });
    }
    if (paths.has(asset.path)) {
      issues.push({
        code: "duplicate_asset_path",
        path: `assets.${index}.path`,
        message: `Dataset asset path ${asset.path} is duplicated.`,
      });
    }
    paths.add(asset.path);
    splitCounts[asset.split] += 1;
  }
  if (release.splitCounts.train > 0 && splitCounts.train === 0) {
    issues.push({
      code: "train_asset_missing",
      path: "assets",
      message: "Dataset Release declares train rows without a train asset.",
    });
  }
  if (
    release.splitCounts.frozenEval > 0 &&
    splitCounts.frozen_eval === 0
  ) {
    issues.push({
      code: "frozen_eval_asset_missing",
      path: "assets",
      message:
        "Dataset Release declares frozen-evaluation rows without a frozen-evaluation asset.",
    });
  }
  return issues;
}

export function validateHarnessRunManifest(
  manifest: HarnessRunManifest,
  graph?: {
    harnessRelease: HarnessRelease;
    evidenceSets: EvidenceSetRelease[];
  },
): ReleaseGraphIssue[] {
  const issues: ReleaseGraphIssue[] = [];
  const { contentHash: manifestHash, ...content } = manifest;
  if (contentHash(content) !== manifestHash) {
    issues.push({
      code: "manifest_hash_mismatch",
      path: "contentHash",
      message: "Harness Run Manifest hash does not match its canonical content.",
    });
  }
  const leaseRefs = new Set<string>();
  const leaseDeclarations = new Set<string>();
  for (const [index, lease] of manifest.secretLeaseRefs.entries()) {
    if (leaseRefs.has(lease.leaseRef)) {
      issues.push({
        code: "duplicate_secret_lease",
        path: `secretLeaseRefs.${index}.leaseRef`,
        message: "Opaque secret lease references must be unique.",
      });
    }
    leaseRefs.add(lease.leaseRef);
    if (leaseDeclarations.has(lease.declarationId)) {
      issues.push({
        code: "duplicate_secret_declaration_lease",
        path: `secretLeaseRefs.${index}.declarationId`,
        message: "A secret declaration can bind only one runtime lease.",
      });
    }
    leaseDeclarations.add(lease.declarationId);
    if (Date.parse(lease.expiresAt) <= Date.parse(manifest.createdAt)) {
      issues.push({
        code: "secret_lease_expired_at_creation",
        path: `secretLeaseRefs.${index}.expiresAt`,
        message: "A runtime secret lease must remain valid after manifest creation.",
      });
    }
  }
  if (manifest.runtimeTarget.dataPlane) {
    if (
      manifest.runtimeTarget.capabilityReceipt ===
      manifest.runtimeTarget.dataPlane.capabilityReceipt
    ) {
      issues.push({
        code: "runtime_and_placement_receipts_collapsed",
        path: "runtimeTarget.dataPlane.capabilityReceipt",
        message:
          "Runtime conformance and exact data-plane placement require independent receipts.",
      });
    }
  }
  if (!graph) return issues;
  issues.push(...validateHarnessRelease(graph.harnessRelease));
  if (
    graph.harnessRelease.id !== manifest.harnessRelease.id ||
    graph.harnessRelease.contentHash !== manifest.harnessRelease.contentHash
  ) {
    issues.push({
      code: "harness_release_mismatch",
      path: "harnessRelease",
      message: "Resolved Harness Release does not match the manifest reference.",
    });
  }
  const declarations = new Map(
    graph.harnessRelease.secretDeclarations.map((item) => [item.id, item]),
  );
  for (const [index, lease] of manifest.secretLeaseRefs.entries()) {
    const declaration = declarations.get(lease.declarationId);
    if (!declaration || declaration.audience !== lease.audience) {
      issues.push({
        code: "secret_lease_not_declared",
        path: `secretLeaseRefs.${index}`,
        message:
          "Every runtime secret lease must match a Harness Release declaration and audience.",
      });
    }
  }
  for (const declaration of graph.harnessRelease.secretDeclarations) {
    if (declaration.required && !leaseDeclarations.has(declaration.id)) {
      issues.push({
        code: "required_secret_lease_missing",
        path: "secretLeaseRefs",
        message: `Required secret declaration ${declaration.id} has no runtime lease.`,
      });
    }
  }
  const manifestEvidenceIdentities = new Set<string>();
  for (const [index, ref] of manifest.evidenceSets.entries()) {
    const identity = `${ref.id}:${ref.contentHash}`;
    if (manifestEvidenceIdentities.has(identity)) {
      issues.push({
        code: "duplicate_evidence_set",
        path: `evidenceSets.${index}`,
        message: "Manifest Evidence Set references must be unique.",
      });
    }
    manifestEvidenceIdentities.add(identity);
  }
  const evidenceByIdentity = new Map(
    graph.evidenceSets.map((release) => [
      `${release.id}:${release.contentHash}`,
      release,
    ]),
  );
  for (const [index, ref] of manifest.evidenceSets.entries()) {
    const evidence = evidenceByIdentity.get(`${ref.id}:${ref.contentHash}`);
    if (!evidence) {
      issues.push({
        code: "evidence_set_missing",
        path: `evidenceSets.${index}`,
        message: "Manifest Evidence Set reference was not resolved.",
      });
      continue;
    }
    issues.push(...validateEvidenceSetRelease(evidence));
    if (
      evidence.datasetRelease.id !== manifest.datasetRelease.id ||
      evidence.datasetRelease.contentHash !== manifest.datasetRelease.contentHash
    ) {
      issues.push({
        code: "evidence_dataset_mismatch",
        path: `evidenceSets.${index}`,
        message: "Evidence Set lineage points to another Dataset Release.",
      });
    }
    if (
      evidence.harnessRelease.id !== manifest.harnessRelease.id ||
      evidence.harnessRelease.contentHash !== manifest.harnessRelease.contentHash
    ) {
      issues.push({
        code: "evidence_harness_mismatch",
        path: `evidenceSets.${index}`,
        message: "Evidence Set lineage points to another Harness Release.",
      });
    }
    if (
      evidence.model.source !== manifest.model.source ||
      evidence.model.revision !== manifest.model.revision ||
      evidence.model.artifactHash !== manifest.model.artifactHash
    ) {
      issues.push({
        code: "evidence_model_mismatch",
        path: `evidenceSets.${index}`,
        message: "Evidence Set lineage points to another Model.",
      });
    }
    const harnessProfile = graph.harnessRelease.profileRelease;
    if (
      (harnessProfile === null) !== (evidence.profileRelease === null) ||
      (harnessProfile !== null &&
        evidence.profileRelease !== null &&
        (harnessProfile.id !== evidence.profileRelease.id ||
          harnessProfile.contentHash !==
            evidence.profileRelease.contentHash))
    ) {
      issues.push({
        code: "evidence_profile_mismatch",
        path: `evidenceSets.${index}`,
        message: "Evidence Set lineage points to another Profile Release.",
      });
    }
  }
  for (const identity of evidenceByIdentity.keys()) {
    if (!manifestEvidenceIdentities.has(identity)) {
      issues.push({
        code: "unreferenced_evidence_set",
        path: "evidenceSets",
        message: "The resolved graph contains an unreferenced Evidence Set.",
      });
    }
  }
  return issues;
}

function safeRelativePath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  return (
    normalized === value &&
    !normalized.startsWith("/") &&
    !normalized.split("/").some((part) => !part || part === "." || part === "..")
  );
}

function releaseGraphError(label: string, issues: ReleaseGraphIssue[]): Error {
  return new Error(
    `${label} validation failed:\n${issues
      .map((issue) => `${issue.code} (${issue.path}): ${issue.message}`)
      .join("\n")}`,
  );
}
