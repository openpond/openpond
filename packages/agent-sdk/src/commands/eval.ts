import path from "node:path";
import { readFile } from "node:fs/promises";
import crypto from "node:crypto";

import { writeJson } from "../core/files";
import { loadAgentProject } from "../core/load-project";
import { createEvalContext, createRunState, writeTrace } from "../core/runner";
import { ARTIFACT_SCHEMAS, DEFAULT_AGENT_CONFIG, SDK_SCHEMA_VERSION } from "../core/constants";
import {
  assertArtifactSchemaCompatibility,
  evalResultsEntry,
  traceEntry,
  writeArtifactIndex,
} from "../core/artifacts";
import type { EvalDefinition } from "../index";
import type { CliOptions } from "../core/types";
import { validateAgentProject, writeValidationReport } from "../core/validation";

export async function evalCommand(options: CliOptions) {
  const project = await loadAgentProject(options.cwd);
  const validation = validateAgentProject(project, options.cwd);
  if (validation.errors.length > 0) {
    await writeValidationReport(options.cwd, validation, options.outDir);
    throw new Error(`Eval blocked by ${validation.errors.length} validation error(s).`);
  }

  const results = [];
  for (const evaluation of project.evals ?? []) {
    const state = createRunState();
    const startedAt = new Date().toISOString();
    try {
      await evaluation.run(createEvalContext(project, state));
      results.push(await resultPayload(options.cwd, options.outDir, evaluation, state, startedAt, "passed"));
    } catch (error) {
      results.push(await resultPayload(options.cwd, options.outDir, evaluation, state, startedAt, "failed", error));
    }
  }

  const passed = results.filter((result) => result.status === "passed").length;
  const publishGateResults = results.filter((result) => result.publishGate.required);
  const publishGateFailed = publishGateResults.filter((result) => result.status !== "passed");
  const payload = {
    schemaVersion: SDK_SCHEMA_VERSION,
    schema: ARTIFACT_SCHEMAS.evalResults,
    command: "openpond-agent eval",
    project: { name: project.name, version: project.version },
    source: await sourceMetadata(options.cwd),
    summary: { total: results.length, passed, failed: results.length - passed },
    publishGate: {
      status: publishGateFailed.length === 0 ? "passed" : "failed",
      total: publishGateResults.length,
      passed: publishGateResults.length - publishGateFailed.length,
      failed: publishGateFailed.length,
      blockingFailures: publishGateFailed.map((result) => result.name),
    },
    results,
  };
  await writeJson(options.cwd, path.join(options.outDir, "eval-results.json"), payload);
  const artifactIndex = await writeArtifactIndex(options.cwd, project, options.outDir, {
    includeStandard: false,
    extraEntries: [
      evalResultsEntry(options.outDir),
      ...results.map((result) => traceEntry(result.traceArtifactRef)),
    ],
  });
  await assertArtifactSchemaCompatibility(options.cwd, {
    ...artifactIndex,
    entries: artifactIndex.entries.filter((entry) =>
      entry.kind === "eval-results" || entry.kind === "trace-jsonl"
    ),
  });

  if (options.json) console.log(JSON.stringify(payload, null, 2));
  else console.log(`${passed}/${results.length} evals passed\nWrote ${path.join(options.outDir, "eval-results.json")}`);
  if (passed !== results.length) process.exitCode = 1;
}

async function resultPayload(
  cwd: string,
  artifactDir: string,
  evaluation: EvalDefinition,
  state: ReturnType<typeof createRunState>,
  startedAt: string,
  status: "passed" | "failed",
  error?: unknown,
) {
  const traceArtifactRef = await writeTrace(cwd, evaluation.name, state, artifactDir);
  const assertionSummary = {
    total: state.assertions.length,
    passed: state.assertions.filter((assertion) => assertion.status === "passed").length,
    failed: state.assertions.filter((assertion) => assertion.status === "failed").length,
  };
  return {
    name: evaluation.name,
    status,
    description: evaluation.description,
    fixtures: await fixtureMetadata(cwd, evaluation.fixtures ?? []),
    publishGate: {
      required: evaluation.publishGate ?? true,
      status: status === "passed" ? "passed" : "failed",
    },
    summary: {
      assertions: assertionSummary,
      events: state.events.length,
      artifacts: state.artifacts.length,
    },
    startedAt,
    finishedAt: new Date().toISOString(),
    traceArtifactRef,
    events: state.events.length,
    artifacts: state.artifacts.map((artifact) => artifact.ref),
    assertions: state.assertions,
    ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
  };
}

async function sourceMetadata(cwd: string) {
  const configPath = path.join(cwd, DEFAULT_AGENT_CONFIG);
  return {
    configPath: DEFAULT_AGENT_CONFIG,
    configHash: await fileHash(configPath),
  };
}

async function fixtureMetadata(cwd: string, fixtures: string[]) {
  return Promise.all(fixtures.map(async (fixture) => {
    const relativePath = fixture.startsWith("./") ? fixture.slice(2) : fixture;
    const filePath = path.join(cwd, relativePath);
    return {
      path: relativePath,
      hash: await fileHash(filePath),
    };
  }));
}

async function fileHash(filePath: string): Promise<string> {
  const contents = await readFile(filePath);
  return crypto.createHash("sha256").update(contents).digest("hex");
}
