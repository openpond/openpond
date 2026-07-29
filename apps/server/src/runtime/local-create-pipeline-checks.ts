import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  buildOpenPondProfileSetupGate,
  formatOpenPondProfileSetupRequirement,
  runAgentSdkProjectCommand,
} from "@openpond/cloud";
import type {
  LocalCreatePipelineCheckInput,
  LocalCreatePipelineCheckResult,
  LocalCreatePipelineTarget,
} from "./local-create-pipeline-types.js";

export async function runLocalCreatePipelineChecks(
  input: LocalCreatePipelineCheckInput
): Promise<LocalCreatePipelineCheckResult> {
  await assertLocalCreateSourceLayout(input.target);
  const checkMetadata: Record<string, unknown> = {};
  const checkRefs = new Set<string>([
    `${input.target.sourceRootRelativePath}/.openpond/agent-inspect.json`,
    `${input.target.sourceRootRelativePath}/.openpond/action-registry.json`,
    `${input.target.sourceRootRelativePath}/.openpond/eval-results.json`,
  ]);
  const commands: Array<{
    name: string;
    command: "inspect" | "build" | "validate" | "eval" | "run";
    args?: string[];
  }> = [
    { name: "inspect", command: "inspect", args: ["--json"] },
    { name: "build", command: "build" },
    { name: "validate", command: "validate", args: ["--json"] },
    { name: "eval", command: "eval", args: ["--json"] },
    {
      name: "direct-run",
      command: "run",
      args: [
        input.target.defaultAction,
        "--json",
        "--input",
        JSON.stringify({
          prompt: input.snapshot.objective,
          channel: "openpond_chat",
        }),
      ],
    },
  ];
  for (const command of commands) {
    const result = await runAgentSdkProjectCommand({
      cwd: input.target.sourceRoot,
      command: command.command,
      args: command.args,
      ...(command.command === "eval" && input.requireEvalPass === false
        ? { throwOnFailure: false }
        : {}),
    });
    if (
      result.code !== 0 &&
      !(command.command === "eval" && input.requireEvalPass === false)
    ) {
      throw new Error(
        result.stderr.trim() ||
          result.stdout.trim() ||
          `${command.command} failed with exit code ${result.code ?? "unknown"}`
      );
    }
    const parsedStdout = parseJsonOutput(result.stdout);
    const traceArtifactRef = traceRefFromCommandResult(parsedStdout);
    if (traceArtifactRef) {
      checkRefs.add(
        path.join(input.target.sourceRootRelativePath, traceArtifactRef)
      );
    }
    checkMetadata[command.name] = {
      summary: summaryFromCommandResult(command.name, parsedStdout),
      traceArtifactRef,
      stdout: result.stdout.trim().slice(0, 4000),
      stderr: result.stderr.trim().slice(0, 4000),
    };
  }
  await assertGeneratedSdkArtifacts(
    input.target,
    input.requireEvalPass !== false
  );
  return {
    checkRefs: [...checkRefs],
    metadata: checkMetadata,
  };
}

export async function assertLocalCreateSourceLayout(
  target: LocalCreatePipelineTarget
): Promise<void> {
  if (!existsSync(target.sourceRoot)) {
    throw new Error(
      `Codex did not create the expected agent source root: ${target.sourceRoot}`
    );
  }
  const agentSourcePath = path.join(target.sourceRoot, "agent", "agent.ts");
  if (!existsSync(agentSourcePath)) {
    throw new Error(
      `Codex did not create the expected SDK agent source: ${agentSourcePath}`
    );
  }
  const rootManifestPath = path.join(target.repoPath, "openpond-profile.json");
  if (!existsSync(rootManifestPath)) {
    throw new Error(
      `Codex did not update the profile repo manifest: ${rootManifestPath}`
    );
  }
  const profileManifestPath = path.join(
    target.sourcePath,
    "settings",
    "profile.yaml"
  );
  if (!existsSync(profileManifestPath)) {
    throw new Error(
      `Codex did not update the profile manifest: ${profileManifestPath}`
    );
  }
  const rootManifest = JSON.parse(await readFile(rootManifestPath, "utf8")) as {
    profiles?: Record<
      string,
      { enabledAgents?: string[]; defaultAgent?: string; path?: string }
    >;
  };
  const profileEntry = rootManifest.profiles?.[target.activeProfile];
  if (!profileEntry) {
    throw new Error(
      `openpond-profile.json does not register profile ${target.activeProfile}.`
    );
  }
  if (!profileEntry.enabledAgents?.includes(target.agentId)) {
    throw new Error(
      `openpond-profile.json does not enable generated agent ${target.agentId}.`
    );
  }
  const profileYaml = await readFile(profileManifestPath, "utf8");
  if (
    !profileYaml.includes(`id: ${target.agentId}`) &&
    !profileYaml.includes(`id: "${target.agentId}"`)
  ) {
    throw new Error(
      `settings/profile.yaml does not register generated agent ${target.agentId}.`
    );
  }
  const expectedPaths =
    target.agentId === "default"
      ? ["agent/agent.ts", "agent"]
      : [`agents/${target.agentId}`];
  if (
    !expectedPaths.some((expectedPath) => profileYaml.includes(expectedPath))
  ) {
    throw new Error(
      `settings/profile.yaml does not point ${target.agentId} at ${expectedPaths[0]}.`
    );
  }
}

async function assertGeneratedSdkArtifacts(
  target: LocalCreatePipelineTarget,
  requireEvalPass = true
): Promise<void> {
  const registryPath = path.join(
    target.sourceRoot,
    ".openpond",
    "action-registry.json"
  );
  const evalResultsPath = path.join(
    target.sourceRoot,
    ".openpond",
    "eval-results.json"
  );
  if (!existsSync(registryPath)) {
    throw new Error(
      `Generated source did not produce an action registry: ${registryPath}`
    );
  }
  if (!existsSync(evalResultsPath)) {
    throw new Error(
      `Generated source did not produce eval results: ${evalResultsPath}`
    );
  }
  const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
    actions?: Array<{
      id?: unknown;
      name?: unknown;
      label?: unknown;
      description?: unknown;
      timeoutSeconds?: unknown;
      setupRequirements?: unknown;
    }>;
  };
  const actions = Array.isArray(registry.actions) ? registry.actions : [];
  const actionIds = new Set(
    actions
      .map((action) => (typeof action.id === "string" ? action.id : null))
      .filter((id): id is string => Boolean(id))
  );
  if (!actionIds.has(target.defaultAction)) {
    throw new Error(
      `Generated action registry does not expose default action ${target.defaultAction}.`
    );
  }
  const missingMetadata = actions.filter(
    (action) =>
      typeof action.id === "string" &&
      (!stringValue(action.label) ||
        !stringValue(action.description) ||
        typeof action.timeoutSeconds !== "number")
  );
  if (missingMetadata.length > 0) {
    throw new Error(
      `Generated action registry has actions missing labels, descriptions, or timeout policies: ${missingMetadata
        .map((action) => action.id)
        .join(", ")}`
    );
  }
  const setupGate = buildOpenPondProfileSetupGate({
    actionCatalog: actions
      .filter((action) => typeof action.id === "string")
      .map((action) => ({
        id: action.id as string,
        name: stringValue(action.name),
        setupRequirements: recordArray(action.setupRequirements) ?? [],
      })),
    actionId: target.defaultAction,
  });
  if (setupGate.blockingRequirements.length > 0) {
    throw new Error(
      `Generated default action ${
        target.defaultAction
      } has unresolved required setup and cannot be ready_local: ${setupGate.blockingRequirements
        .map(formatOpenPondProfileSetupRequirement)
        .join(
          "; "
        )}. Mark built-in/local fixture requirements ready or optional when they are satisfied, or leave the pipeline blocked until the setup is configured.`
    );
  }
  const evalResults = JSON.parse(await readFile(evalResultsPath, "utf8")) as {
    summary?: { total?: unknown; failed?: unknown };
  };
  if (
    typeof evalResults.summary?.total !== "number" ||
    evalResults.summary.total < 1
  ) {
    throw new Error(
      "Generated source must define at least one deterministic SDK eval."
    );
  }
  if (requireEvalPass && evalResults.summary.failed !== 0) {
    throw new Error("Generated source evals did not all pass.");
  }
}

function parseJsonOutput(stdout: string): unknown | null {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function recordArray(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is Record<string, unknown> =>
    Boolean(asRecord(item))
  );
}

function traceRefFromCommandResult(value: unknown): string | null {
  const record = asRecord(value);
  const ref = stringValue(record?.traceArtifactRef);
  return ref?.startsWith(".openpond/") ? ref : null;
}

function summaryFromCommandResult(
  commandName: string,
  value: unknown
): Record<string, unknown> | null {
  const record = asRecord(value);
  if (!record) return null;
  if (commandName === "inspect") {
    return {
      actionCount: Array.isArray(record.actionCatalog)
        ? record.actionCatalog.length
        : null,
      defaultAction: asRecord(record.agent)?.defaultAction ?? null,
      projectName: asRecord(record.project)?.name ?? null,
    };
  }
  if (commandName === "validate") {
    return {
      status: record.status ?? null,
      errors: asRecord(record.summary)?.errors ?? null,
      warnings: asRecord(record.summary)?.warnings ?? null,
    };
  }
  if (commandName === "eval") {
    return asRecord(record.summary);
  }
  if (commandName === "direct-run") {
    return {
      hasResult: Boolean(asRecord(record.result)),
      resultKeys: Object.keys(asRecord(record.result) ?? {}),
    };
  }
  return null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
