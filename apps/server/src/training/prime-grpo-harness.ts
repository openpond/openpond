import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  PrimeRolloutAssignmentSchema,
  type LearningSignalLineage,
  type OpenPondProfileState,
  type ResolvedTrainingPlan,
  type Taskset,
} from "@openpond/contracts";
import {
  materializeHarnessRelease,
  type PortableTrainingReleaseGraph,
} from "@openpond/training-sdk";
import { canonicalJson, contentHash } from "@openpond/taskset-sdk";

import {
  createOpenAiCompatibleMarketingPolicy,
  runMarketingPortfolioRollout,
} from "./marketing-portfolio-rollout.js";
import { createMarketingRolloutLearningSignals } from "./marketing-rollout-signals.js";
import { createProfileAgentHarnessRuntime } from "./profile-agent-harness-runtime.js";
import { verifyMarketingAgentRuntime } from "./task-creator-agent-benchmark.js";

type GroupedAssignment = {
  schemaVersion: "openpond.groupedGrpoAssignment.v1";
  runId: string;
  manifestId: string;
  manifestHash: string;
  step: number;
  rolloutGroupId: string;
  groupIndex: number;
  taskId: string;
  policyVersion: number;
  seed: number;
  createdAt: string;
  assignmentHash: string;
};

export async function createPrimeGrpoHarness(input: {
  storeDir: string;
  artifactRoot: string;
  graph: PortableTrainingReleaseGraph;
  plan: ResolvedTrainingPlan;
  taskset: Taskset;
  profile: OpenPondProfileState;
  localInferencePort: number;
}) {
  const [student, environment, verifiedAgent] = await Promise.all([
    materializeProjection(input, "student"),
    materializeProjection(input, "environment"),
    verifyMarketingAgentRuntime({
      taskset: input.taskset,
      profile: input.profile,
    }),
  ]);
  const runtime = createProfileAgentHarnessRuntime({
    agentRoot: verifiedAgent.agentRoot,
    scorerModulePath: verifiedAgent.scorerModulePath,
    artifactRoot: input.artifactRoot,
  });
  const traceRoot = path.join(input.artifactRoot, "traces");
  await mkdir(traceRoot, { recursive: true, mode: 0o700 });
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/grouped-rollout") {
      response.writeHead(404).end();
      return;
    }
    try {
      const grouped = parseGroupedAssignment(
        JSON.parse(await readRequestBody(request)),
        input.plan
      );
      const task = input.taskset.tasks.find(
        (candidate) =>
          candidate.id === grouped.taskId && candidate.split === "train"
      );
      if (!task) {
        throw new Error(
          `Grouped GRPO task ${grouped.taskId} is not an immutable train row.`
        );
      }
      const modelId =
        grouped.policyVersion === 0
          ? input.plan.manifest.model.source
          : `openpond-policy-v${grouped.policyVersion}`;
      const assignmentCore = {
        schemaVersion: "openpond.primeRolloutAssignment.v1" as const,
        runId: grouped.runId,
        resolvedBundleHash: input.graph.resolvedBundleManifest.contentHash,
        taskset: {
          id: input.taskset.id,
          revision: input.taskset.revision,
          contentHash: input.taskset.contentHash,
        },
        harnessRelease: input.plan.manifest.harnessRelease,
        profileRelease: input.taskset.profileRelease!,
        agentRelease:
          input.taskset.environment.actionBindings![0]!.agentRelease!,
        taskId: task.id,
        split: "train" as const,
        policyVersion: grouped.policyVersion,
        model: {
          id: modelId,
          revision: input.plan.manifest.model.revision,
        },
        inferencePort: input.localInferencePort,
        createdAt: grouped.createdAt,
      };
      const assignment = PrimeRolloutAssignmentSchema.parse({
        ...assignmentCore,
        assignmentHash: contentHash(assignmentCore),
      });
      const result = await runMarketingPortfolioRollout({
        assignment,
        taskset: input.taskset,
        task,
        studentManifest: student.manifest,
        environmentManifest: environment.manifest,
        policy: createOpenAiCompatibleMarketingPolicy({
          baseUrl: `http://127.0.0.1:${input.localInferencePort}/v1`,
          modelId,
          maximumOutputTokens:
            input.plan.recipe.method === "grpo"
              ? input.plan.recipe.rollout.maxOutputTokens
              : 1_024,
          temperature:
            input.plan.recipe.method === "grpo"
              ? input.plan.recipe.rollout.temperature
              : 0.2,
          topP:
            input.plan.recipe.method === "grpo"
              ? input.plan.recipe.rollout.topP
              : 0.95,
          seed: grouped.seed,
          captureOptimizerSample: true,
        }),
        executeAction: runtime.executeAction,
        scoreDecision: runtime.scoreDecision,
        maxTurns:
          input.plan.recipe.method === "grpo"
            ? input.plan.recipe.rollout.maxTurns
            : 8,
      });
      const traceCore = {
        schemaVersion: "openpond.primeGrpoTrace.v1",
        groupedAssignment: grouped,
        rolloutAssignment: assignment,
        result,
      };
      const traceHash = contentHash(traceCore);
      const tracePath = path.join(traceRoot, `${result.resultHash}.json`);
      await writeFile(
        tracePath,
        canonicalJson({ ...traceCore, contentHash: traceHash }),
        { flag: "wx", mode: 0o600 }
      );
      const signals = createMarketingRolloutLearningSignals({
        result,
        lineage: createPrimeGrpoLearningSignalLineage({
          plan: input.plan,
          taskset: input.taskset,
          verificationReceiptHash: traceHash,
        }),
        traceRef: path
          .relative(input.storeDir, tracePath)
          .split(path.sep)
          .join("/"),
        traceHash,
        graderEvidenceRefs: result.grade ? [result.grade.traceHash] : [],
        createdAt: result.completedAt,
      });
      response.writeHead(200, {
        "content-type": "application/json",
      });
      response.end(canonicalJson({ result, signals }));
    } catch (error) {
      response.writeHead(500, {
        "content-type": "application/json",
      });
      response.end(
        JSON.stringify({
          error: safeMessage(error),
        })
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () => closeServer(server),
  };
}

async function materializeProjection(
  input: {
    artifactRoot: string;
    graph: PortableTrainingReleaseGraph;
  },
  projection: "student" | "environment"
) {
  return materializeHarnessRelease({
    release: input.graph.harnessRelease,
    cacheRoot: path.join(input.artifactRoot, "harness", projection),
    target: {
      adapterId: "local-harness",
      projection,
      runtimeVersion: "openpond.primeGrpo.v1",
      expectedContracts: input.graph.harnessRelease.requiredContracts,
    },
    readAsset: async (asset) => {
      const value = input.graph.assets.get(asset.path);
      if (!value) {
        throw new Error(`Harness release asset ${asset.path} is unavailable.`);
      }
      return value;
    },
  });
}

function parseGroupedAssignment(
  value: unknown,
  plan: ResolvedTrainingPlan
): GroupedAssignment {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Grouped GRPO assignment must be an object.");
  }
  const assignment = value as Record<string, unknown>;
  const { assignmentHash, ...core } = assignment;
  if (
    assignment.schemaVersion !== "openpond.groupedGrpoAssignment.v1" ||
    assignment.runId !== plan.manifest.id ||
    assignment.manifestId !== plan.manifest.id ||
    assignment.manifestHash !== plan.manifest.contentHash ||
    typeof assignment.step !== "number" ||
    !Number.isInteger(assignment.step) ||
    assignment.step < 1 ||
    typeof assignment.groupIndex !== "number" ||
    !Number.isInteger(assignment.groupIndex) ||
    assignment.groupIndex < 0 ||
    typeof assignment.policyVersion !== "number" ||
    !Number.isInteger(assignment.policyVersion) ||
    assignment.policyVersion !== assignment.step - 1 ||
    typeof assignment.seed !== "number" ||
    !Number.isInteger(assignment.seed) ||
    typeof assignment.rolloutGroupId !== "string" ||
    !assignment.rolloutGroupId ||
    typeof assignment.taskId !== "string" ||
    !assignment.taskId ||
    typeof assignment.createdAt !== "string" ||
    !assignment.createdAt ||
    assignmentHash !== contentHash(core)
  ) {
    throw new Error("Grouped GRPO assignment hash or lineage is invalid.");
  }
  return assignment as GroupedAssignment;
}

export function createPrimeGrpoLearningSignalLineage(input: {
  plan: ResolvedTrainingPlan;
  taskset: Taskset;
  verificationReceiptHash: string;
}): LearningSignalLineage {
  if (input.plan.recipe.method !== "grpo") {
    throw new Error("Learning-signal lineage requires GRPO.");
  }
  return {
    datasetRelease: input.plan.manifest.datasetRelease,
    harnessRelease: input.plan.manifest.harnessRelease,
    evidenceSetRelease: input.plan.manifest.evidenceSets[0] ?? null,
    profileRelease: input.taskset.profileRelease
      ? {
          id: input.taskset.profileRelease.id,
          contentHash: input.taskset.profileRelease.contentHash,
        }
      : null,
    model: {
      source: input.plan.manifest.model.source,
      revision: input.plan.manifest.model.revision,
      artifactHash: input.plan.manifest.model.artifactHash,
    },
    environmentHash: contentHash(input.taskset.environment),
    graderHash: input.plan.recipe.reward.graderHash,
    toolContractHash: input.plan.recipe.reward.toolContractHash,
    verificationReceiptHash: input.verificationReceiptHash,
  };
}

async function readRequestBody(
  request: import("node:http").IncomingMessage
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > 16 * 1024 * 1024) {
      throw new Error("Grouped GRPO callback exceeded 16 MiB.");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2_000);
}
