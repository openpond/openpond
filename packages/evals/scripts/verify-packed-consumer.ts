import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const harnessRoot = path.resolve(root, "../harness");
const temporary = await mkdtemp(path.join(os.tmpdir(), "openpond-evals-consumer-"));

try {
  const harnessTarball = pack(harnessRoot);
  const evalsTarball = pack(root);
  await writeFile(
    path.join(temporary, "package.json"),
    `${JSON.stringify({
      name: "openpond-evals-clean-consumer",
      private: true,
      type: "module",
    }, null, 2)}\n`,
  );
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      path.join(temporary, harnessTarball.filename),
      path.join(temporary, evalsTarball.filename),
    ],
    { cwd: temporary, stdio: "inherit" },
  );
  await writeFile(path.join(temporary, "verify.mjs"), `
import { HarnessReleaseSchema } from "@openpond/harness";
import {
  RunManifestSchema,
  TasksetReleaseSchema,
  buildArtifactManifest,
  createAttemptReceipt,
  createCanonicalRolloutRecord,
  createEnvironmentRelease,
  createRewardReceipt,
  createVerifierSetRelease,
  gradeEvidence,
  verifyRewardReceipt,
  verifyAttemptReceipt,
  verifyCanonicalRolloutRecord,
  verifyRequiredOutputs,
} from "@openpond/evals";
import { genericToolConformance } from "@openpond/evals/conformance";
import { workEvidenceConformance, verifyWorkEvidenceReceipt } from "@openpond/evals/evidence";
import { CORE_METRIC_CATALOG, createRunTelemetryEvent } from "@openpond/evals/telemetry";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { LearningCommandRequestSchema, LearningSourceSchema, TaskExampleSubmissionSchema, sealLearningContent, validateSourceSubmission } from "@openpond/evals/learning";
import { RewardReleaseSchema } from "@openpond/evals/rewards";
const definitionRef = { id: "consumer-definition", revision: 1, contentHash: "a".repeat(64) };
const source = LearningSourceSchema.parse(sealLearningContent({ schemaVersion: "openpond.learningSource.v1", id: "consumer-source", revision: 1, name: "Consumer source", kind: "direct", taskDefinition: definitionRef, enabled: true, allowedSplits: ["train"], mapping: null, adapterVersion: null }));
const example = TaskExampleSubmissionSchema.parse({ schemaVersion: "openpond.taskExample.v1", sourceId: source.id, taskDefinition: definitionRef, idempotencyKey: "consumer-example", exampleId: "example", attemptId: "attempt", occurredAt: "2026-09-06T12:00:00.000Z", familyKey: "family", split: "train", input: { question: "Two plus two?" }, observedOutput: { answer: "5" }, expected: { answer: "4" }, evaluatorContext: { private: true }, assets: [], provenance: { sourceRecordRef: null, mappingHash: null } });
const wire = JSON.parse(JSON.stringify({ scope: "consumer", command: { action: "submit_example", operationId: example.idempotencyKey, example } }));
LearningCommandRequestSchema.parse(wire);
validateSourceSubmission(source, wire.command.example);
const packageRoot = path.dirname(createRequire(import.meta.url).resolve("@openpond/evals/package.json"));
const wireSchema = JSON.parse(readFileSync(path.join(packageRoot, "schemas/learning/v1/example-submission.schema.json"), "utf8"));
const validateWire = new Ajv2020({ strict: false }).compile(wireSchema);
if (!validateWire(example) || validateWire({ ...example, actor: "forged" })) throw new Error("Published structural schema disagrees with producer boundary");
if (!RewardReleaseSchema || example.observedOutput.answer === example.expected.answer) throw new Error("Public learning exports failed");
HarnessReleaseSchema.parse(genericToolConformance.harness);
RunManifestSchema.parse(genericToolConformance.manifest);
TasksetReleaseSchema.parse(genericToolConformance.taskset);
const grades = await gradeEvidence({
  task: genericToolConformance.taskset.tasks[0],
  evidence: { output: { text: "done" }, runtimeEventRefs: [], artifactRefs: [] },
  graders: genericToolConformance.taskset.graders,
});
if (!grades[0]?.passed) throw new Error("packed deterministic grader failed");
if (verifyAttemptReceipt({}) !== false) throw new Error("invalid receipt was accepted");
const environment = createEnvironmentRelease({
  schemaVersion: "openpond.environmentRelease.v1",
  id: "packed-environment",
  revision: 1,
  contract: genericToolConformance.taskset.environment,
  actionSchemaRef: null,
  observationSchemaRef: null,
  stateSchemaRef: null,
  artifactCollection: { maxArtifacts: 10, maxTotalBytes: 1000000 },
  adapterConformanceHashes: { local: genericToolConformance.manifest.contentHash },
  metadata: {},
});
const verifierSet = createVerifierSetRelease({
  schemaVersion: "openpond.verifierSetRelease.v1",
  id: "packed-verifier-set",
  revision: 1,
  graders: genericToolConformance.taskset.graders,
  isolation: { processBoundary: "isolated_process", networkPolicy: "none", defaultTimeoutMs: 1000 },
  calibrationReceiptRefs: [],
  metadata: {},
});
const attemptReceipt = createAttemptReceipt({
  schemaVersion: "openpond.attemptReceipt.v1",
  id: "packed-attempt",
  runManifest: { id: genericToolConformance.manifest.id, contentHash: genericToolConformance.manifest.contentHash },
  taskId: genericToolConformance.taskset.tasks[0].id,
  seed: "0",
  terminal: true,
  failureClass: "policy_failure",
  outputHash: genericToolConformance.manifest.contentHash,
  traceHash: genericToolConformance.manifest.contentHash,
  artifactRefs: [],
  graderEvidenceRefs: [],
  startedAt: "2026-08-17T00:00:00.000Z",
  completedAt: "2026-08-17T00:00:00.000Z",
  latencyMs: 0,
  costUsd: 0,
  legacyAttemptRef: null,
  metadata: {},
});
const attemptRef = { id: attemptReceipt.id, contentHash: attemptReceipt.contentHash };
const requiredOutput = { path: "index.html", mediaType: "text/html", schemaRef: null, maxBytes: 1000, metadata: {} };
const artifactManifest = buildArtifactManifest({
  id: "packed-artifact-manifest",
  attemptRef,
  requiredOutputs: [requiredOutput],
  collectedArtifacts: [],
  createdAt: "2026-08-17T00:00:00.000Z",
});
const components = verifyRequiredOutputs({ requiredOutputs: [requiredOutput], manifest: artifactManifest });
const rewardReceipt = createRewardReceipt({
  id: "packed-zero-reward",
  attemptRef,
  verifierSet,
  artifactManifest,
  outcomeClass: "incomplete_output",
  failureOwner: "policy",
  components,
  createdAt: "2026-08-17T00:00:00.000Z",
});
if (rewardReceipt.reward !== 0 || !rewardReceipt.learningEligible || !verifyRewardReceipt(rewardReceipt)) {
  throw new Error("packed scored-zero Reward Receipt failed");
}
const rollout = createCanonicalRolloutRecord({
  id: "packed-rollout",
  attemptReceipt,
  rewardReceipt,
  artifactManifestRef: { id: artifactManifest.id, contentHash: artifactManifest.contentHash },
  tasksetRelease: { id: genericToolConformance.taskset.id, contentHash: genericToolConformance.taskset.contentHash },
  environmentRelease: { id: environment.id, contentHash: environment.contentHash },
  harnessRelease: { id: genericToolConformance.harness.id, contentHash: genericToolConformance.harness.contentHash },
  taskId: genericToolConformance.taskset.tasks[0].id,
  split: "train",
  model: genericToolConformance.manifest.model,
  seed: "0",
  traceRef: { id: "packed-trace", contentHash: attemptReceipt.traceHash, mediaType: "application/json", sizeBytes: null },
  optimizerSample: null,
  environmentExecutions: [{
    id: "packed-environment-execution",
    environmentRelease: { id: environment.id, contentHash: environment.contentHash },
    status: "completed",
    startedAt: "2026-08-17T00:00:00.000Z",
    completedAt: "2026-08-17T00:00:00.000Z",
    traceRefs: [],
    metadata: {},
  }],
  startedAt: "2026-08-17T00:00:00.000Z",
  completedAt: "2026-08-17T00:00:00.000Z",
});
if (rollout.reward.value !== 0 || !verifyCanonicalRolloutRecord(rollout)) {
  throw new Error("packed canonical rollout failed");
}
if (!environment.contentHash) throw new Error("packed Environment Release failed");
if (!verifyWorkEvidenceReceipt(workEvidenceConformance.receipt)) {
  throw new Error("packed Work evidence validation failed");
}
const telemetry = createRunTelemetryEvent({
  sequence: 0,
  occurredAt: "2026-08-17T00:00:00.000Z",
  source: "control_plane",
  type: "run_started",
  visibility: "team_visible",
  lineage: {
    modelProjectId: "packed-project",
    runId: "packed-run",
    modelVersionId: null,
    harnessReleaseHash: genericToolConformance.harness.contentHash,
    tasksetReleaseHash: genericToolConformance.taskset.contentHash,
    environmentReleaseHash: null,
    checkpointId: null,
    step: null,
    rolloutGroupId: null,
    attemptId: null,
    scenarioId: null,
  },
});
if (telemetry.sequence !== 0 || CORE_METRIC_CATALOG.length < 10) throw new Error("packed telemetry failed");
process.stdout.write("clean Evals consumer verified\\n");
`);
  await writeFile(path.join(temporary, "verify-types.mts"), `
import type { HarnessRelease } from "@openpond/harness";
import type {
  AttemptReceipt,
  EvaluationRunner,
  GraderEvidence,
  ArtifactManifest,
  CanonicalRolloutRecord,
  EnvironmentRelease,
  RewardReceipt,
  RunManifest,
  TaskRecord,
  WorkEvidenceReceipt,
} from "@openpond/evals";
import type { MetricObservation, RunTelemetryEvent } from "@openpond/evals/telemetry";
import type { LearningRepository, LearningCommand, TaskExampleSubmission, TaskGradeExecutor } from "@openpond/evals/learning";
import type { RewardBinding, RewardRelease } from "@openpond/evals/rewards";
void (null as unknown as LearningRepository | LearningCommand | TaskExampleSubmission | TaskGradeExecutor | RewardBinding | RewardRelease);
void (null as unknown as HarnessRelease | AttemptReceipt | ArtifactManifest | CanonicalRolloutRecord | EnvironmentRelease | EvaluationRunner | GraderEvidence | RewardReceipt | RunManifest | TaskRecord | WorkEvidenceReceipt | MetricObservation | RunTelemetryEvent);
`);
  execFileSync(process.execPath, [path.join(temporary, "verify.mjs")], {
    cwd: temporary,
    stdio: "inherit",
  });
  execFileSync(path.resolve(root, "../../node_modules/.bin/tsc"), [
    "--noEmit",
    "--strict",
    "--skipLibCheck",
    "--target",
    "ES2022",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    path.join(temporary, "verify-types.mts"),
  ], { cwd: temporary, stdio: "inherit" });
  const manifest = JSON.parse(await readFile(
    path.join(temporary, "node_modules/@openpond/evals/package.json"),
    "utf8",
  )) as { version?: string };
  console.log(
    `Verified packed @openpond/evals@${manifest.version ?? "unknown"} with integrity ${evalsTarball.integrity}.`,
  );
} finally {
  await rm(temporary, { force: true, recursive: true });
}

function pack(packageRoot: string): { filename: string; integrity: string } {
  const packed = JSON.parse(execFileSync(
    "npm",
    ["pack", packageRoot, "--json", "--pack-destination", temporary],
    { cwd: temporary, encoding: "utf8" },
  )) as Array<{ filename: string; integrity: string }>;
  const tarball = packed[0];
  if (!tarball?.filename || !tarball.integrity) {
    throw new Error(`npm pack did not return integrity metadata for ${packageRoot}.`);
  }
  return tarball;
}
