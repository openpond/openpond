import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  TASKSET_WORK_TOOL_NAMES,
  TasksetSchema,
  type DatasetSplit,
  type TaskAssetRef,
  type TaskDataRecord,
  type Taskset,
} from "@openpond/contracts";

import { buildTaskset } from "./materialize.js";
import { contentHash, sha256 } from "./hashing.js";
import { computeTasksetHash, validateTaskset } from "./validation.js";

export const HARVEY_LAB_REPOSITORY = "harveyai/harvey-labs";
export const HARVEY_LAB_REPOSITORY_URL =
  "https://github.com/harveyai/harvey-labs";
export const HARVEY_LAB_REVISION =
  "a2b429eb6c9683c4fdeced3bc6b3af36edf239a6";
export const HARVEY_LAB_COMMIT_DATE = "2026-08-26T04:28:23Z";
export const HARVEY_LAB_DECLARED_LICENSE = "MIT";
export const HARVEY_LAB_LEGAL_TASKSET_ID =
  "harvey_lab_contract_review_continuous_rl_v1";
export const HARVEY_LAB_LEGAL_WEEK0_TASKSET_ID =
  "harvey_lab_contract_review_week0_v1";

export type HarveyLabLegalReleaseStage = "week0" | "all";

const MSA_FAMILY =
  "tasks/contracts/commercial-vendor-customer/master-services-agreement-counterparty-paper-review";
const SAAS_FAMILY =
  "tasks/contracts/commercial-vendor-customer/saas-api-subscription-counterparty-paper-review";

export const HARVEY_LAB_LEGAL_SCENARIOS = [
  ...scenarioRange(MSA_FAMILY, "week0-msa", 1, 4, "train"),
  ...scenarioRange(MSA_FAMILY, "week0-msa", 5, 5, "validation"),
  ...scenarioRange(MSA_FAMILY, "week0-msa", 6, 6, "frozen_eval"),
  ...scenarioRange(SAAS_FAMILY, "week1-saas", 1, 3, "train"),
  ...scenarioRange(SAAS_FAMILY, "week1-saas", 4, 4, "validation"),
  ...scenarioRange(SAAS_FAMILY, "week1-saas", 5, 5, "frozen_eval"),
] as const;

type HarveyLabCriterion = {
  id: string;
  title: string;
  match_criteria: string;
};

type HarveyLabTask = {
  title: string;
  instructions: string;
  criteria: HarveyLabCriterion[];
};

export type HarveyLabFile = {
  path: string;
  size: number;
  sha?: string;
};

export type HarveyLabClient = {
  listFiles(directory: string): Promise<HarveyLabFile[]>;
  readBytes(filePath: string): Promise<Uint8Array>;
};

export type MaterializedHarveyLabTaskset = {
  taskset: Taskset;
  tasksetRoot: string;
  sourceRevision: string;
  assetCount: number;
  assetBytes: number;
};

export async function materializeHarveyLabLegalTaskset(input: {
  storeDir: string;
  profileId?: string;
  client?: HarveyLabClient;
  now?: string;
  releaseStage?: HarveyLabLegalReleaseStage;
}): Promise<MaterializedHarveyLabTaskset> {
  const profileId = input.profileId ?? "default";
  const now = input.now ?? HARVEY_LAB_COMMIT_DATE;
  const client = input.client ?? createGitHubHarveyLabClient();
  const releaseStage = input.releaseStage ?? "all";
  const selectedScenarios = releaseStage === "week0"
    ? HARVEY_LAB_LEGAL_SCENARIOS.filter((scenario) => scenario.release === "week0-msa")
    : HARVEY_LAB_LEGAL_SCENARIOS;
  const tasksetId = releaseStage === "week0"
    ? HARVEY_LAB_LEGAL_WEEK0_TASKSET_ID
    : HARVEY_LAB_LEGAL_TASKSET_ID;
  const tasksetRoot = path.join(
    input.storeDir,
    "training",
    "tasksets",
    tasksetId,
  );
  const assetRoot = path.join(tasksetRoot, "assets");
  await mkdir(assetRoot, { recursive: true });

  const tasks: TaskDataRecord[] = [];
  const sourceRefs: Taskset["sourceRefs"] = [];
  let assetCount = 0;
  let assetBytes = 0;

  for (const selected of selectedScenarios) {
    const taskPath = `${selected.path}/task.json`;
    const taskBytes = await client.readBytes(taskPath);
    const upstream = parseHarveyLabTask(taskPath, taskBytes);
    const documentFiles = (await client.listFiles(`${selected.path}/documents`))
      .filter((file) => !file.path.endsWith("/"))
      .sort((left, right) => left.path.localeCompare(right.path));
    if (documentFiles.length === 0) {
      throw new Error(`Harvey LAB scenario has no document assets: ${selected.path}`);
    }

    const taskId = harveyLabTaskId(selected.release, selected.path);
    const sourceId = `source_${taskId}`;
    const scenarioAssetRoot = path.join(assetRoot, taskId);
    await mkdir(scenarioAssetRoot, { recursive: true });
    const assets: TaskAssetRef[] = [];
    const sourceHashes = [sha256(taskBytes)];
    const originalFileNames: string[] = [];
    const mediaTypes = new Set<string>(["application/json"]);
    let sourceBytes = taskBytes.byteLength;

    for (const [index, file] of documentFiles.entries()) {
      const bytes = await client.readBytes(file.path);
      if (file.size !== bytes.byteLength) {
        throw new Error(
          `Harvey LAB asset size mismatch for ${file.path}: expected ${file.size}, received ${bytes.byteLength}.`,
        );
      }
      const digest = sha256(bytes);
      const fileName = path.posix.basename(file.path);
      const mediaType = mediaTypeFor(fileName);
      await writeFile(path.join(scenarioAssetRoot, fileName), bytes, {
        mode: 0o600,
      });
      sourceHashes.push(digest);
      originalFileNames.push(fileName);
      mediaTypes.add(mediaType);
      sourceBytes += bytes.byteLength;
      assetBytes += bytes.byteLength;
      assetCount += 1;
      assets.push({
        id: `asset_${taskId}_${index + 1}`,
        sourceRefId: sourceId,
        artifactRef: `assets/${taskId}/${fileName}`,
        fileName,
        mediaType,
        sha256: digest,
        sizeBytes: bytes.byteLength,
        split: selected.split,
        metadata: {
          upstreamPath: file.path,
          upstreamGitBlobSha: file.sha ?? null,
        },
      });
    }

    sourceRefs.push({
      schemaVersion: "openpond.uploadedFileDatasetSource.v1",
      id: sourceId,
      kind: "uploaded_file",
      profileId,
      title: `${upstream.title} (${selected.release})`,
      sourceHash: contentHash({
        repository: HARVEY_LAB_REPOSITORY,
        revision: HARVEY_LAB_REVISION,
        taskPath,
        sourceHashes,
      }),
      occurredAt: HARVEY_LAB_COMMIT_DATE,
      licensingStatus: "approved",
      secretScanStatus: "passed",
      piiScanStatus: "passed",
      originalFileNames,
      mediaTypes: [...mediaTypes].filter((value) => value !== "application/json"),
      sourceFileHashes: sourceHashes,
      totalBytes: sourceBytes,
      parserVersion: "openpond-harvey-lab-v1",
      metadata: {
        repository: HARVEY_LAB_REPOSITORY,
        repositoryUrl: HARVEY_LAB_REPOSITORY_URL,
        revision: HARVEY_LAB_REVISION,
        declaredLicense: HARVEY_LAB_DECLARED_LICENSE,
        taskPath,
        taskJsonSha256: sourceHashes[0],
      },
    });

    tasks.push({
      schemaVersion: "openpond.taskData.v1",
      id: taskId,
      clusterKey: `${selected.release}_${scenarioName(selected.path)}`,
      split: selected.split,
      input: {
        prompt: upstream.instructions,
      },
      expectedOutput: {
        criteria: upstream.criteria,
        criterionCount: upstream.criteria.length,
      },
      policyVisibleContext: {
        title: upstream.title,
        release: selected.release,
      },
      privilegedContextRef: `rubric_${taskId}`,
      sourceRefs: [sourceId],
      assets,
      requiredOutputs: parseRequiredOutputs(upstream.instructions, taskPath),
      tags: ["legal", "contract-review", "harvey-lab", selected.release],
      metadata: {
        release: selected.release,
        upstreamPath: selected.path,
        upstreamCriterionCount: upstream.criteria.length,
        benchmarkFamily: selected.path.slice(0, selected.path.lastIndexOf("/")),
        exampleOrigin: "expert_authored",
      },
    });
  }

  const fixtureTaskId = tasks[0]!.id;
  const fixtureIds = [
    "positive",
    "negative",
    "boundary",
    "adversarial",
    "prompt_injection",
    "infrastructure_failure",
  ] as const;
  const graderFixtures = fixtureIds.map((label) => ({
    id: `fixture_harvey_lab_${label}`,
    taskId: fixtureTaskId,
    label,
    output: label === "infrastructure_failure"
      ? {}
      : {
          artifactManifest: {
            requiredOutputsPresent: label === "positive" || label === "boundary",
          },
          rubricFixtureClass: label,
        },
    infrastructureError: label === "infrastructure_failure"
      ? "Synthetic Work infrastructure failure."
      : null,
    expectedPassed: label === "positive" || label === "boundary",
    expectedRewardEligible: label === "positive" || label === "boundary",
    metadata: {
      fixturePurpose: "judge-contract-shape",
      synthetic: true,
    },
  }));
  const calibrationFixtureRefs = graderFixtures.map((fixture) => fixture.id);

  const draft = TasksetSchema.parse({
    schemaVersion: "openpond.taskset.v1",
    id: tasksetId,
    revision: 5,
    profileId,
    createImproveRunId: null,
    name: releaseStage === "week0"
      ? "Harvey LAB contract review — Week 0 MSA"
      : "Harvey LAB contract review — continuous RL",
    objective:
      "Improve an OpenPond Work agent's contract redlines and risk memos against hidden, criterion-level legal review rubrics.",
    purpose: "general",
    benchmark: null,
    preferenceComparison: null,
    status: "ready",
    sourceRefs,
    policy: {
      policyVisibleFields: [
        "input.prompt",
        "policyVisibleContext",
        "assets",
        "requiredOutputs",
      ],
      privilegedFields: ["expectedOutput.criteria"],
      hiddenGraderRefs: ["grader_harvey_lab_rubric_judge"],
      connectedAppScopes: [],
    },
    environment: {
      protocolVersion: "openpond.taskEnvironment.v1",
      kind: "work",
      entrypoint: "openpond-work-v1",
      stateful: false,
      deterministicSeeds: true,
      toolNames: TASKSET_WORK_TOOL_NAMES.filter((tool) => tool !== "work_stop"),
      lifecycle: ["create", "reset", "step", "grade", "cleanup"],
      defaultTimeoutMs: 1_200_000,
      networkPolicy: "none",
      metadata: {
        maxToolTurns: 40,
        workspaceLayout: "openpond-work-v1",
        sourceAssetsReadOnly: true,
        policySystemPrompt: contractReviewPolicySystemPrompt(),
      },
    },
    capabilities: {
      schemaVersion: "openpond.tasksetCapabilities.v1",
      taskKind: "single_agent",
      supportedSignals: ["reward"],
      compatibleMethods: ["grpo"],
      rewardKinds: ["model_judge"],
      requiresTools: true,
      requiresState: false,
      requiresPrivilegedGrading: true,
      environmentPlacements: ["local", "remote", "colocated"],
      exportable: true,
      portabilityBlockers: [],
    },
    metrics: {
      schemaVersion: "openpond.tasksetMetricPolicy.v1",
      primaryMetric: "criterion_pass_rate",
      aggregation: "mean_score",
      missingReward: "zero",
      customAggregator: null,
    },
    tasks,
    graders: [{
      id: "grader_harvey_lab_rubric_judge",
      version: "4",
      label: "Harvey LAB criterion judge",
      kind: "model_judge",
      rubric: legalCriterionJudgeRubric(),
      judge: {
        providerId: "openpond",
        modelId: "gpt-5.6-luna",
      },
      calibrationFixtureRefs,
      calibrationStatus: "pending",
      temperature: 0,
      weight: 1,
      hardGate: false,
      rewardEligible: true,
      privileged: true,
      metadata: {
        upstreamEvaluator: "harvey-labs-default-dual-judge",
        rewardModelRole: "llm_as_judge",
        userSelectedReward: true,
        calibrationIsAdvisory: true,
      },
    }],
    graderFixtures,
    learningSignals: {
      demonstrations: [],
      preferences: [],
      corrections: [],
      feedback: [],
      rewards: [{
        id: "reward_harvey_lab_criterion_pass_rate",
        kind: "reward",
        taskId: null,
        sourceRefs: sourceRefs.map((source) => source.id),
        artifactRef: "grader_harvey_lab_rubric_judge",
        approved: true,
        confidence: 1,
        task: "Score every hidden Harvey LAB criterion against the produced redline and risk memo.",
        rules: [{
          id: "mean_criterion_pass_rate",
          points: 1,
          condition: "Return the fraction of hidden criteria that pass, in the closed interval [0, 1].",
        }],
        otherwisePoints: 0,
        executable: true,
        metadata: {
          aggregation: "mean_binary_criterion_pass",
          userDefined: true,
        },
      }],
      labels: [],
    },
    authoringProvenance: {
      schemaVersion: "openpond.taskAuthoringProvenance.v1",
      model: null,
      modelConfig: {},
      skillHash: contentHash("openpond-harvey-lab-contract-review-v1"),
      promptTemplateVersion: "harvey-lab-upstream-instructions-v1",
      buildIntent: "rubric",
      buildSpecification: null,
      evidenceHashes: sourceRefs.flatMap((source) =>
        "sourceFileHashes" in source ? source.sourceFileHashes : []
      ),
      tasksetSdkVersion: "0.0.1",
      sourceCommit: HARVEY_LAB_REVISION,
      repairHistory: [],
      createdAt: now,
    },
    readiness: null,
    contentHash: "00000000",
    createdAt: now,
    updatedAt: now,
    metadata: {
      trainingMethod: "grpo",
      externalBenchmark: "Harvey LAB",
      externalBenchmarkRepository: HARVEY_LAB_REPOSITORY_URL,
      externalBenchmarkRevision: HARVEY_LAB_REVISION,
      releaseStage,
      releaseOrder: releaseStage === "week0"
        ? ["week0-msa"]
        : ["week0-msa", "week1-saas"],
      trainingJudgeProtocol: "gpt-5.6-luna-cpu-rubric-judge",
      finalJudgeProtocol: "independent-dual-judge-pending",
      tasksetOutputContract: {
        mode: "artifacts",
        requiredOutputSource: "task.requiredOutputs",
      },
      diagnosis: {
        summary: "Contract-review behavior is stable enough to optimize in model weights; each attempt still receives its matter-specific source documents through the Work harness.",
        stableBehavior: [
          "Identify deviations from a negotiation playbook.",
          "Draft usable redlines and issue-focused risk memos.",
          "Use the OpenPond Work tool and artifact protocol reliably.",
        ],
        changingKnowledge: [
          "Counterparty paper, client playbook, and matter facts remain runtime inputs.",
        ],
        requiredContext: ["Task instructions", "Matter-specific source documents"],
        requiredTools: [...TASKSET_WORK_TOOL_NAMES].filter((tool) => tool !== "work_stop"),
        intervention: "grpo",
        trainingEligible: true,
        rationale: [
          "The hidden criterion pass rate provides a scalar outcome reward.",
          "The target behavior requires multi-step document inspection and artifact production.",
        ],
        confidence: 0.9,
      },
    },
  });
  const taskset = TasksetSchema.parse({
    ...draft,
    contentHash: computeTasksetHash(draft),
  });
  const validation = validateTaskset(taskset);
  const errors = validation.issues.filter((issue) => issue.severity === "error");
  if (errors.length > 0) {
    throw new Error(errors.map((issue) => `${issue.code}: ${issue.message}`).join("\n"));
  }
  await buildTaskset(taskset, tasksetRoot);
  return {
    taskset,
    tasksetRoot,
    sourceRevision: HARVEY_LAB_REVISION,
    assetCount,
    assetBytes,
  };
}

export function createGitHubHarveyLabClient(
  fetcher: typeof fetch = fetch,
): HarveyLabClient {
  return {
    async listFiles(directory) {
      const safePath = safeRepositoryPath(directory);
      const encodedPath = safePath.split("/").map(encodeURIComponent).join("/");
      const entries = await fetchJson<Array<{
        path: string;
        type: string;
        size: number;
        sha: string;
      }>>(
        fetcher,
        `https://api.github.com/repos/${HARVEY_LAB_REPOSITORY}/contents/${encodedPath}?ref=${HARVEY_LAB_REVISION}`,
      );
      return entries
        .filter((entry) => entry.type === "file")
        .map((entry) => ({
          path: entry.path,
          size: entry.size,
          sha: entry.sha,
        }));
    },
    async readBytes(filePath) {
      const safePath = safeRepositoryPath(filePath);
      const response = await fetcher(
        `https://raw.githubusercontent.com/${HARVEY_LAB_REPOSITORY}/${HARVEY_LAB_REVISION}/${safePath}`,
        { headers: { "User-Agent": "openpond-taskset-sdk" } },
      );
      if (!response.ok) {
        throw new Error(
          `Unable to fetch pinned Harvey LAB file ${safePath}: ${response.status} ${response.statusText}`,
        );
      }
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

function scenarioRange(
  family: string,
  release: string,
  first: number,
  last: number,
  split: DatasetSplit,
) {
  return Array.from({ length: last - first + 1 }, (_, offset) => ({
    path: `${family}/scenario-${String(first + offset).padStart(2, "0")}`,
    release,
    split,
  }));
}

function parseHarveyLabTask(filePath: string, bytes: Uint8Array): HarveyLabTask {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid Harvey LAB task JSON at ${filePath}.`, { cause: error });
  }
  if (!value || typeof value !== "object") {
    throw new Error(`Harvey LAB task is not an object at ${filePath}.`);
  }
  const task = value as Partial<HarveyLabTask>;
  if (
    typeof task.title !== "string"
    || typeof task.instructions !== "string"
    || !Array.isArray(task.criteria)
    || task.criteria.length === 0
    || task.criteria.some((criterion) =>
      !criterion
      || typeof criterion.id !== "string"
      || typeof criterion.title !== "string"
      || typeof criterion.match_criteria !== "string"
    )
  ) {
    throw new Error(`Harvey LAB task contract is invalid at ${filePath}.`);
  }
  return task as HarveyLabTask;
}

function parseRequiredOutputs(instructions: string, taskPath: string) {
  const match = instructions.match(/(?:^|\n)### Output:\s*\n([\s\S]*?)(?=\n### |$)/i);
  let fileNames = (match?.[1] ?? "")
    .split("\n")
    .map((line) => line.trim().replace(/^[-*]\s*/, ""))
    .filter(Boolean);
  if (fileNames.length === 0) {
    fileNames = [...instructions.matchAll(/\(\d+\)\s*`([^`]+\.[A-Za-z0-9]+)`/g)]
      .map((entry) => entry[1]!.trim());
  }
  if (fileNames.length === 0) {
    throw new Error(`Harvey LAB task instructions do not declare any outputs: ${taskPath}`);
  }
  return fileNames.map((fileName) => ({
    path: fileName,
    mediaType: mediaTypeFor(fileName),
    maxBytes: 10_000_000,
    metadata: { upstreamDeclared: true },
  }));
}

function harveyLabTaskId(release: string, scenarioPath: string): string {
  const family = scenarioPath.split("/").at(-2) ?? "task";
  return `harvey_lab_${release}_${family}_${scenarioName(scenarioPath)}`
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .slice(0, 240);
}

function scenarioName(scenarioPath: string): string {
  return scenarioPath.split("/").at(-1) ?? "scenario";
}

function mediaTypeFor(fileName: string): string {
  switch (path.posix.extname(fileName).toLowerCase()) {
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".pdf":
      return "application/pdf";
    case ".eml":
      return "message/rfc822";
    case ".json":
      return "application/json";
    case ".csv":
      return "text/csv";
    case ".md":
      return "text/markdown";
    case ".txt":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}

function legalCriterionJudgeRubric(): string {
  return [
    "Evaluate the produced output artifacts against every criterion in the task's privileged expectedOutput.criteria array.",
    "Treat each criterion independently and follow its match_criteria literally.",
    "Return a binary pass/fail result and concise evidence for every criterion.",
    "The scalar reward is passed criteria divided by total criteria.",
    "Missing or unreadable required artifacts receive zero reward.",
    "Do not expose hidden criteria to the policy before or during its attempt.",
  ].join("\n");
}

function contractReviewPolicySystemPrompt(): string {
  return [
    "You are the OpenPond contract-review agent. Complete the matter as a careful commercial contracts reviewer acting for the client identified in the instructions.",
    "Matter intake: inventory every supplied file before drafting and identify which documents are controlling, supporting, or contextual.",
    "Document review: inspect the complete relevant agreement, exhibits, emails, spreadsheets, playbooks, and standard forms. Use bounded extraction or search commands for binary and long documents.",
    "Playbook analysis: compare counterparty language to the client's required position, fallback, escalation thresholds, and financial exposure. Do not invent facts or silently resolve genuine ambiguity.",
    "Redline production: create a valid, reviewable DOCX at the exact declared filename. Preserve usable document structure and make proposed changes explicit.",
    "Risk memo: create the exact declared memo DOCX, prioritize issues, cite the relevant agreement language and playbook position, explain risk, and state the proposed resolution.",
    "Self-review: verify every required filename, document validity, issue coverage, calculations, grounding, consistency between redline and memo, and absence of unsupported findings before saving outputs.",
    "Attorney handoff: clearly flag unresolved judgment calls in the work product. Do not send, negotiate, or communicate externally.",
  ].join("\n\n");
}

function safeRepositoryPath(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/");
  if (
    !normalized
    || normalized.startsWith("/")
    || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`Unsafe repository path: ${value}`);
  }
  return normalized;
}

async function fetchJson<T>(fetcher: typeof fetch, url: string): Promise<T> {
  const response = await fetcher(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "openpond-taskset-sdk",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub request failed: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export function harveyLabSourceReceipt(input: {
  taskset: Taskset;
  assetBytes: ReadonlyMap<string, Uint8Array>;
}): { tasksetHash: string; assetSetHash: string } {
  const lines = [...input.assetBytes.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([assetPath, bytes]) => `${sha256(bytes)}  ${assetPath}`);
  return {
    tasksetHash: input.taskset.contentHash,
    assetSetHash: createHash("sha256").update(lines.join("\n")).digest("hex"),
  };
}
