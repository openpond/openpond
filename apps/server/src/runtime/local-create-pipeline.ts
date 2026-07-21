import {
  DEFAULT_CODEX_CHAT_MODEL,
  nextCreateImproveRunRevision,
  type CreateImproveRun,
  type RuntimeEvent,
  type SendTurnRequest,
  type Session,
  type Turn,
} from "@openpond/contracts";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  buildOpenPondProfileSetupGate,
  formatOpenPondProfileSetupRequirement,
  runAgentSdkProjectCommand,
} from "@openpond/cloud";
import type { RuntimeCodexSession } from "../types.js";
import { scriptedOpenPondModelsEnabled } from "../openpond/scripted-chat-provider.js";
import { event } from "../utils.js";

export const MODEL_BACKED_LOCAL_CREATE_REQUIRED_REASON =
  "Approved local Create plans require model-backed SDK source application; no source mutation was performed.";
export const LOCAL_CREATE_CODEX_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
export const HARNESS_PREPARED_SOURCE_MANIFEST = ".openpond-harness-source-application.json";
const LOCAL_CREATE_TIMEOUT_RECOVERY_MS = 5 * 60 * 1000;
const LOCAL_CREATE_TIMEOUT_RECOVERY_POLL_MS = 2 * 1000;
const LOCAL_CREATE_TIMEOUT_RECOVERY_STABLE_MS = 5 * 1000;

type CodexTurnInput = Pick<
  SendTurnRequest,
  "approvalPolicy" | "sandbox" | "model" | "codexPermissionMode" | "codexReasoningEffort"
>;

export type LocalCreatePipelineApplyOptions = {
  session?: Session;
  turn?: Turn;
  ensureCodexRuntime?: (
    session: Session,
    turnInput: CodexTurnInput,
  ) => Promise<RuntimeCodexSession>;
  appendRuntimeEvent?: (runtimeEvent: RuntimeEvent) => Promise<void>;
  setProviderTurnId?: (providerTurnId: string) => Promise<void>;
  onSnapshot?: (snapshot: CreateImproveRun) => Promise<void>;
  model?: string | null;
  codexReasoningEffort?: CodexTurnInput["codexReasoningEffort"];
  runChecks?: (input: LocalCreatePipelineCheckInput) => Promise<LocalCreatePipelineCheckResult>;
  now?: () => string;
};

export type LocalCreatePipelineCheckInput = {
  snapshot: CreateImproveRun;
  target: LocalCreatePipelineTarget;
  requireEvalPass?: boolean;
};

export type LocalCreatePipelineCheckResult = {
  checkRefs: string[];
  metadata?: Record<string, unknown>;
};

export type LocalCreatePipelineTarget = {
  activeProfile: string;
  agentId: string;
  defaultAction: string;
  repoPath: string;
  sourcePath: string;
  workspaceRoot: string;
  profileRelativePath: string;
  sourceRoot: string;
  sourceRootRelativePath: string;
};

export async function applyApprovedLocalCreateImproveRun(
  snapshot: CreateImproveRun,
  options: LocalCreatePipelineApplyOptions = {},
): Promise<CreateImproveRun> {
  if (!shouldApplyLocalCreatePipeline(snapshot)) return snapshot;
  const now = options.now ?? (() => new Date().toISOString());
  const adapter = snapshot.adapter;
  if (adapter.kind !== "local") return snapshot;
  if (
    !options.session ||
    !options.turn ||
    !options.ensureCodexRuntime ||
    !options.appendRuntimeEvent ||
    !options.setProviderTurnId
  ) {
    return blockLocalCreatePipeline(snapshot, {
      now: now(),
      reason: MODEL_BACKED_LOCAL_CREATE_REQUIRED_REASON,
      metadata: {
        reason: "model_backed_source_application_required",
        sourcePath: adapter.sourcePath ?? null,
        repoPath: adapter.repoPath ?? null,
        activeProfile: adapter.activeProfile ?? null,
        operation: snapshot.operation,
        requestedAgentId: snapshot.target.kind === "agent" ? snapshot.target.id : null,
      },
    });
  }

  let target: LocalCreatePipelineTarget;
  try {
    target = resolveLocalCreatePipelineTarget(snapshot);
  } catch (error) {
    return blockLocalCreatePipeline(snapshot, {
      now: now(),
      reason: error instanceof Error ? error.message : String(error),
      metadata: {
        reason: "local_create_target_unresolved",
      },
    });
  }

  try {
    await runModelBackedLocalCreateSourceApplication({
      snapshot,
      session: options.session,
      turn: options.turn,
      target,
      ensureCodexRuntime: options.ensureCodexRuntime,
      appendRuntimeEvent: options.appendRuntimeEvent,
      setProviderTurnId: options.setProviderTurnId,
      model: options.model ?? DEFAULT_CODEX_CHAT_MODEL,
      codexReasoningEffort: options.codexReasoningEffort,
    });
  } catch (error) {
    return blockLocalCreatePipeline(snapshot, {
      now: now(),
      reason: error instanceof Error ? error.message : String(error),
      metadata: {
        reason: "model_backed_source_application_failed",
        target,
      },
    });
  }

  const runningChecks = transitionCreatePipeline(snapshot, {
    state: "running_checks",
    now: now(),
    blockedReason: null,
    sourceRefs: [
      target.sourceRootRelativePath,
      path.join(target.profileRelativePath, "settings", "profile.yaml"),
      "openpond-profile.json",
    ],
    metadata: {
      localCreatePipeline: {
        status: "running_checks",
        target,
      },
    },
    candidates: [
      {
        id: agentCandidateId(snapshot.id),
        target: {
          kind: "agent",
          id: target.agentId,
          displayName: snapshot.target.displayName,
          defaultActionKey: target.defaultAction,
        },
        status: "checking",
        git: null,
        parentCandidateId: null,
        tasksetRef: snapshot.tasksetRef,
        authoringModelRef: options.model ?? null,
        allowedPaths: snapshot.plan?.sourcePlan.map((item) => item.path) ?? [],
        sourceRefs: [
          target.sourceRootRelativePath,
          path.join(target.profileRelativePath, "settings", "profile.yaml"),
          "openpond-profile.json",
        ],
        artifactRefs: [],
        checkRefs: [],
        evaluationReceiptRefs: [],
        createdAt: snapshot.createdAt,
        updatedAt: now(),
        metadata: { sourceAuthority: snapshot.adapter.sourceAuthority },
      },
    ],
  });
  await options.onSnapshot?.(runningChecks);

  try {
    const checkResult = await (options.runChecks ?? runLocalCreatePipelineChecks)({
      snapshot: runningChecks,
      target,
    });
    const completedAt = now();
    const candidateId = agentCandidateId(snapshot.id);
    const evaluationReceiptId = `agent_eval_${snapshot.id}`;
    return transitionCreatePipeline(runningChecks, {
      state: "ready_local",
      now: completedAt,
      blockedReason: null,
      checkRefs: checkResult.checkRefs,
      candidates: runningChecks.candidates.map((candidate) =>
        candidate.id === candidateId
          ? {
              ...candidate,
              status: "accepted",
              checkRefs: mergeRefs(candidate.checkRefs, checkResult.checkRefs),
              evaluationReceiptRefs: mergeRefs(
                candidate.evaluationReceiptRefs,
                [evaluationReceiptId],
              ),
              updatedAt: completedAt,
            }
          : candidate,
      ),
      evaluationReceipts: [
        ...runningChecks.evaluationReceipts.filter((receipt) => receipt.id !== evaluationReceiptId),
        {
          id: evaluationReceiptId,
          candidateId,
          target: {
            kind: "agent",
            id: target.agentId,
            displayName: snapshot.target.displayName,
            defaultActionKey: target.defaultAction,
          },
          evaluatorKind: "agent_sdk",
          subject: "candidate",
          sourceCommit: snapshot.adapter.kind === "local" ? snapshot.adapter.localHead : null,
          sourceBranch: null,
          tasksetId: snapshot.tasksetRef?.id ?? null,
          tasksetHash: snapshot.tasksetRef?.contentHash ?? null,
          taskAttemptRefs: checkResult.checkRefs.filter((ref) => ref.includes("eval")),
          status: "passed",
          publishGate: "passed",
          summaryCounts: null,
          evalRefs: checkResult.checkRefs.filter((ref) => ref.includes("eval")),
          artifactRefs: checkResult.checkRefs,
          summary: checkSummary(checkResult.metadata),
          createdAt: completedAt,
          metadata: checkResult.metadata ?? {},
        },
      ],
      metadata: {
        localCreatePipeline: {
          status: "ready_local",
          target,
          checks: checkResult.metadata ?? {},
        },
      },
    });
  } catch (error) {
    return blockLocalCreatePipeline(runningChecks, {
      now: now(),
      reason: error instanceof Error ? error.message : String(error),
      metadata: {
        reason: "local_create_checks_failed",
        target,
      },
    });
  }
}

export function shouldApplyLocalCreatePipeline(snapshot: CreateImproveRun): boolean {
  return Boolean(
    snapshot.state === "applying_source" &&
      snapshot.plan?.status === "approved" &&
      snapshot.adapter.kind === "local" &&
      snapshot.target.kind === "agent",
  );
}

function transitionCreatePipeline(
  snapshot: CreateImproveRun,
  input: {
    state: CreateImproveRun["state"];
    now: string;
    blockedReason?: string | null;
    checkRefs?: string[];
    sourceRefs?: string[];
    candidates?: CreateImproveRun["candidates"];
    evaluationReceipts?: CreateImproveRun["evaluationReceipts"];
    metadata?: Record<string, unknown>;
  },
): CreateImproveRun {
  return nextCreateImproveRunRevision(snapshot, {
    state: input.state,
    blockedReason:
      input.blockedReason === undefined ? snapshot.blockedReason : input.blockedReason,
    checkRefs: mergeRefs(snapshot.checkRefs, input.checkRefs ?? []),
    sourceRefs: mergeRefs(snapshot.sourceRefs, input.sourceRefs ?? []),
    candidates: input.candidates ?? snapshot.candidates,
    evaluationReceipts: input.evaluationReceipts ?? snapshot.evaluationReceipts,
    metadata: {
      ...snapshot.metadata,
      ...(input.metadata ?? {}),
    },
    updatedAt: input.now,
  });
}

function blockLocalCreatePipeline(
  snapshot: CreateImproveRun,
  input: {
    now: string;
    reason: string;
    metadata?: Record<string, unknown>;
  },
): CreateImproveRun {
  return transitionCreatePipeline(snapshot, {
    state: "blocked",
    now: input.now,
    blockedReason: input.reason,
    metadata: {
      localCreatePipeline: {
        status: "blocked",
        ...input.metadata,
      },
    },
  });
}

function mergeRefs(existing: string[], next: string[]): string[] {
  return Array.from(new Set([...existing, ...next].filter(Boolean)));
}

function agentCandidateId(runId: string): string {
  return `agent_candidate_${runId}`;
}

function checkSummary(metadata: Record<string, unknown> | undefined): string {
  const evaluation = asRecord(metadata?.eval);
  const total = typeof evaluation?.total === "number" ? evaluation.total : null;
  return total === null
    ? "Agent SDK checks and deterministic Evals passed."
    : `${total} Agent SDK Eval${total === 1 ? "" : "s"} passed.`;
}

export function resolveLocalCreatePipelineTarget(snapshot: CreateImproveRun): LocalCreatePipelineTarget {
  const adapter = snapshot.adapter;
  if (adapter.kind !== "local") throw new Error("Create/Improve target must use the local adapter.");
  if (snapshot.target.kind !== "agent") throw new Error("Local agent source application requires an Agent target.");
  const sourcePath = adapter.sourcePath?.trim();
  const repoPath = adapter.repoPath?.trim();
  if (!sourcePath) throw new Error("Local Create approval is missing a profile source path.");
  if (!repoPath) throw new Error("Local Create approval is missing a profile repo path.");
  const activeProfile = adapter.activeProfile?.trim() || "default";
  const resolvedSourcePath = path.resolve(sourcePath);
  const resolvedRepoPath = path.resolve(repoPath);
  const agentId =
    normalizeAgentId(snapshot.target.id) ??
    agentIdFromSourcePlan(snapshot) ??
    slugFromObjective(snapshot.objective);
  const defaultAction = sourceActionIdForAgent(
    normalizeActionId(snapshot.plan?.defaultChatAction.key) ?? "chat",
    agentId,
  );
  const sourceRoot = snapshot.operation === "improve" && agentId === "default"
    ? resolvedSourcePath
    : path.join(resolvedSourcePath, "agents", agentId);
  return {
    activeProfile,
    agentId,
    defaultAction,
    repoPath: resolvedRepoPath,
    sourcePath: resolvedSourcePath,
    workspaceRoot: resolvedRepoPath,
    profileRelativePath: normalizeRelativePath(path.relative(resolvedRepoPath, resolvedSourcePath)),
    sourceRoot,
    sourceRootRelativePath: normalizeRelativePath(path.relative(resolvedRepoPath, sourceRoot)),
  };
}

export async function runModelBackedLocalCreateSourceApplication(input: {
  snapshot: CreateImproveRun;
  session: Session;
  turn: Turn;
  target: LocalCreatePipelineTarget;
  ensureCodexRuntime: NonNullable<LocalCreatePipelineApplyOptions["ensureCodexRuntime"]>;
  appendRuntimeEvent: NonNullable<LocalCreatePipelineApplyOptions["appendRuntimeEvent"]>;
  setProviderTurnId: NonNullable<LocalCreatePipelineApplyOptions["setProviderTurnId"]>;
  model: string | null;
  codexReasoningEffort?: CodexTurnInput["codexReasoningEffort"];
}): Promise<void> {
  if (!existsSync(input.target.workspaceRoot)) {
    throw new Error(`Profile repo path does not exist: ${input.target.workspaceRoot}`);
  }
  if (!existsSync(input.target.sourcePath)) {
    throw new Error(`Profile source path does not exist: ${input.target.sourcePath}`);
  }
  if (await applyPreparedHarnessSourceApplication(input.snapshot, input.target)) {
    await input.appendRuntimeEvent(
      event({
        sessionId: input.session.id,
        turnId: input.turn.id,
        name: "create_improve.updated",
        source: "server",
        appId: input.session.appId,
        status: "completed",
        output: `Applied prepared harness ${input.snapshot.operation === "improve" ? "Improve" : "Create"} source for ${input.target.agentId}; running local checks.`,
        data: {
          phase: "prepared_source_apply_completed",
          runId: input.snapshot.id,
          target: input.target,
        },
      }),
    );
    return;
  }
  await input.appendRuntimeEvent(
    event({
      sessionId: input.session.id,
      turnId: input.turn.id,
      name: "create_improve.updated",
      source: "server",
      appId: input.session.appId,
      status: "started",
      output: `Applying approved ${input.snapshot.operation === "improve" ? "Improve" : "Create"} plan with Codex in ${input.target.sourceRootRelativePath}.`,
      data: {
        phase: "source_apply_started",
        runId: input.snapshot.id,
        target: input.target,
      },
    }),
  );
  const codexSession: Session = {
    ...input.session,
    provider: "codex",
    cwd: input.target.workspaceRoot,
    workspaceKind: "local_project",
    workspaceId: input.session.workspaceId ?? `openpond-profile:${input.target.activeProfile}`,
    workspaceName: input.session.workspaceName ?? `OpenPond profile ${input.target.activeProfile}`,
  };
  const codexModel = input.session.provider === "codex" ? input.model : null;
  const runtime = await input.ensureCodexRuntime(codexSession, {
    approvalPolicy: "never",
    sandbox: "workspace-write",
    model: codexModel,
    codexPermissionMode: "auto-review",
    codexReasoningEffort: input.codexReasoningEffort,
  });
  const providerTurn = await runtime.client.startTurn({
    threadId: runtime.threadId,
    prompt: localCreatePipelinePrompt(input.snapshot, input.target),
    cwd: input.target.workspaceRoot,
    model: codexModel,
    approvalPolicy: "never",
    sandbox: "workspace-write",
  });
  await input.setProviderTurnId(providerTurn.turnId);
  try {
    await runtime.client.waitForTurn(providerTurn.turnId, LOCAL_CREATE_CODEX_WAIT_TIMEOUT_MS);
  } catch (error) {
    if (!isCodexTurnTimeoutError(error, providerTurn.turnId) && !isCodexAppServerCleanExitError(error)) {
      throw error;
    }
    const recoveryReason = isCodexTurnTimeoutError(error, providerTurn.turnId)
      ? "timed out"
      : "exited cleanly before returning a turn completion";
    await input.appendRuntimeEvent(
      event({
        sessionId: input.session.id,
        turnId: input.turn.id,
        name: "create_improve.updated",
        source: "server",
        appId: input.session.appId,
        status: "started",
        output: `Codex source application ${recoveryReason}; checking for completed generated source before blocking.`,
        data: {
          phase: "source_apply_recovery_started",
          runId: input.snapshot.id,
          providerTurnId: providerTurn.turnId,
          reason: recoveryReason,
          target: input.target,
        },
      }),
    );
    const recovered = await waitForTimedOutSourceApplication(input.target);
    if (!recovered) throw error;
    await input.appendRuntimeEvent(
      event({
        sessionId: input.session.id,
        turnId: input.turn.id,
        name: "create_improve.updated",
        source: "server",
        appId: input.session.appId,
        status: "completed",
        output: `Recovered completed ${input.snapshot.operation === "improve" ? "Improve" : "Create"} source after Codex source application ${recoveryReason} for ${input.target.agentId}; running local checks.`,
        data: {
          phase: "source_apply_recovered",
          runId: input.snapshot.id,
          providerTurnId: providerTurn.turnId,
          reason: recoveryReason,
          target: input.target,
        },
      }),
    );
  }
  await input.appendRuntimeEvent(
    event({
      sessionId: input.session.id,
      turnId: input.turn.id,
      name: "create_improve.updated",
      source: "provider",
      appId: input.session.appId,
      status: "completed",
      output: `Codex completed approved ${input.snapshot.operation === "improve" ? "Improve" : "Create"} source application for ${input.target.agentId}.`,
      data: {
        phase: "source_apply_completed",
        runId: input.snapshot.id,
        providerTurnId: providerTurn.turnId,
        target: input.target,
      },
    }),
  );
}

type HarnessPreparedSourceOperation = {
  source: string;
  registrations?: Array<{
    source: string;
    target: string;
  }>;
};

export async function applyPreparedHarnessSourceApplication(
  snapshot: CreateImproveRun,
  target: LocalCreatePipelineTarget,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (!scriptedOpenPondModelsEnabled(env)) return false;
  const manifestPath = path.join(target.workspaceRoot, HARNESS_PREPARED_SOURCE_MANIFEST);
  if (!existsSync(manifestPath)) return false;
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  const root = asRecord(manifest);
  if (root?.schema !== "openpond.harnessPreparedSource.v1") {
    throw new Error(`${HARNESS_PREPARED_SOURCE_MANIFEST} must use schema openpond.harnessPreparedSource.v1.`);
  }
  const agents = asRecord(root.agents);
  const agent = asRecord(agents?.[target.agentId]);
  const operation = asHarnessPreparedSourceOperation(agent?.[snapshot.operation]);
  if (!operation) return false;

  const sourcePath = resolveHarnessManifestPath(target.workspaceRoot, operation.source, "source");
  if (!existsSync(sourcePath)) {
    throw new Error(`Prepared harness source does not exist: ${operation.source}`);
  }
  await mkdir(target.sourceRoot, { recursive: true });
  await cp(sourcePath, target.sourceRoot, { recursive: true, force: true });
  for (const registration of operation.registrations ?? []) {
    const registrationSource = resolveHarnessManifestPath(
      target.workspaceRoot,
      registration.source,
      "registration source",
    );
    const registrationTarget = resolveHarnessManifestPath(
      target.workspaceRoot,
      registration.target,
      "registration target",
    );
    if (!existsSync(registrationSource)) {
      throw new Error(`Prepared harness registration source does not exist: ${registration.source}`);
    }
    await mkdir(path.dirname(registrationTarget), { recursive: true });
    await cp(registrationSource, registrationTarget, { force: true });
  }
  return true;
}

function asHarnessPreparedSourceOperation(value: unknown): HarnessPreparedSourceOperation | null {
  const operation = asRecord(value);
  if (!operation || typeof operation.source !== "string" || !operation.source.trim()) return null;
  if (operation.registrations !== undefined && !Array.isArray(operation.registrations)) {
    throw new Error("Prepared harness source registrations must be an array.");
  }
  const registrations = (operation.registrations ?? []).map((value) => {
    const registration = asRecord(value);
    if (
      !registration
      || typeof registration.source !== "string"
      || !registration.source.trim()
      || typeof registration.target !== "string"
      || !registration.target.trim()
    ) {
      throw new Error("Prepared harness source registrations require source and target paths.");
    }
    return { source: registration.source, target: registration.target };
  });
  return { source: operation.source, registrations };
}

function resolveHarnessManifestPath(workspaceRoot: string, relativePath: string, label: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`Prepared harness ${label} must be relative to the profile repo.`);
  }
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Prepared harness ${label} must stay inside the profile repo.`);
  }
  return resolved;
}

function isCodexTurnTimeoutError(error: unknown, turnId: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message === `codex turn ${turnId} timed out`;
}

function isCodexAppServerCleanExitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("codex app-server exited with code 0");
}

async function waitForTimedOutSourceApplication(target: LocalCreatePipelineTarget): Promise<boolean> {
  const deadline = Date.now() + LOCAL_CREATE_TIMEOUT_RECOVERY_MS;
  while (Date.now() < deadline) {
    if (await localCreateSourceLayoutIsStable(target)) return true;
    await sleep(LOCAL_CREATE_TIMEOUT_RECOVERY_POLL_MS);
  }
  return false;
}

async function localCreateSourceLayoutIsStable(target: LocalCreatePipelineTarget): Promise<boolean> {
  try {
    await assertLocalCreateSourceLayout(target);
    const before = await sourceLayoutFingerprint(target);
    await sleep(LOCAL_CREATE_TIMEOUT_RECOVERY_STABLE_MS);
    await assertLocalCreateSourceLayout(target);
    const after = await sourceLayoutFingerprint(target);
    return before === after;
  } catch {
    return false;
  }
}

async function sourceLayoutFingerprint(target: LocalCreatePipelineTarget): Promise<string> {
  const paths = [
    path.join(target.sourceRoot, "agent", "agent.ts"),
    path.join(target.sourceRoot, "package.json"),
    path.join(target.repoPath, "openpond-profile.json"),
    path.join(target.sourcePath, "settings", "profile.yaml"),
  ];
  const parts = await Promise.all(
    paths.map(async (filePath) => {
      const content = await readFile(filePath, "utf8");
      return `${filePath}:${content.length}:${content}`;
    }),
  );
  return parts.join("\n---\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runLocalCreatePipelineChecks(
  input: LocalCreatePipelineCheckInput,
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
    if (result.code !== 0 && !(command.command === "eval" && input.requireEvalPass === false)) {
      throw new Error(
        result.stderr.trim() ||
          result.stdout.trim() ||
          `${command.command} failed with exit code ${result.code ?? "unknown"}`,
      );
    }
    const parsedStdout = parseJsonOutput(result.stdout);
    const traceArtifactRef = traceRefFromCommandResult(parsedStdout);
    if (traceArtifactRef) {
      checkRefs.add(path.join(input.target.sourceRootRelativePath, traceArtifactRef));
    }
    checkMetadata[command.name] = {
      summary: summaryFromCommandResult(command.name, parsedStdout),
      traceArtifactRef,
      stdout: result.stdout.trim().slice(0, 4000),
      stderr: result.stderr.trim().slice(0, 4000),
    };
  }
  await assertGeneratedSdkArtifacts(input.target, input.requireEvalPass !== false);
  return {
    checkRefs: [...checkRefs],
    metadata: checkMetadata,
  };
}

async function assertLocalCreateSourceLayout(target: LocalCreatePipelineTarget): Promise<void> {
  if (!existsSync(target.sourceRoot)) {
    throw new Error(`Codex did not create the expected agent source root: ${target.sourceRoot}`);
  }
  const agentSourcePath = path.join(target.sourceRoot, "agent", "agent.ts");
  if (!existsSync(agentSourcePath)) {
    throw new Error(`Codex did not create the expected SDK agent source: ${agentSourcePath}`);
  }
  const rootManifestPath = path.join(target.repoPath, "openpond-profile.json");
  if (!existsSync(rootManifestPath)) {
    throw new Error(`Codex did not update the profile repo manifest: ${rootManifestPath}`);
  }
  const profileManifestPath = path.join(target.sourcePath, "settings", "profile.yaml");
  if (!existsSync(profileManifestPath)) {
    throw new Error(`Codex did not update the profile manifest: ${profileManifestPath}`);
  }
  const rootManifest = JSON.parse(await readFile(rootManifestPath, "utf8")) as {
    profiles?: Record<string, { enabledAgents?: string[]; defaultAgent?: string; path?: string }>;
  };
  const profileEntry = rootManifest.profiles?.[target.activeProfile];
  if (!profileEntry) {
    throw new Error(`openpond-profile.json does not register profile ${target.activeProfile}.`);
  }
  if (!profileEntry.enabledAgents?.includes(target.agentId)) {
    throw new Error(`openpond-profile.json does not enable generated agent ${target.agentId}.`);
  }
  const profileYaml = await readFile(profileManifestPath, "utf8");
  if (!profileYaml.includes(`id: ${target.agentId}`) && !profileYaml.includes(`id: "${target.agentId}"`)) {
    throw new Error(`settings/profile.yaml does not register generated agent ${target.agentId}.`);
  }
  const expectedPaths = target.agentId === "default"
    ? ["agent/agent.ts", "agent"]
    : [`agents/${target.agentId}`];
  if (!expectedPaths.some((expectedPath) => profileYaml.includes(expectedPath))) {
    throw new Error(`settings/profile.yaml does not point ${target.agentId} at ${expectedPaths[0]}.`);
  }
}

async function assertGeneratedSdkArtifacts(
  target: LocalCreatePipelineTarget,
  requireEvalPass = true,
): Promise<void> {
  const registryPath = path.join(target.sourceRoot, ".openpond", "action-registry.json");
  const evalResultsPath = path.join(target.sourceRoot, ".openpond", "eval-results.json");
  if (!existsSync(registryPath)) {
    throw new Error(`Generated source did not produce an action registry: ${registryPath}`);
  }
  if (!existsSync(evalResultsPath)) {
    throw new Error(`Generated source did not produce eval results: ${evalResultsPath}`);
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
      .filter((id): id is string => Boolean(id)),
  );
  if (!actionIds.has(target.defaultAction)) {
    throw new Error(`Generated action registry does not expose default action ${target.defaultAction}.`);
  }
  const missingMetadata = actions.filter(
    (action) =>
      typeof action.id === "string" &&
      (!stringValue(action.label) || !stringValue(action.description) || typeof action.timeoutSeconds !== "number"),
  );
  if (missingMetadata.length > 0) {
    throw new Error(
      `Generated action registry has actions missing labels, descriptions, or timeout policies: ${missingMetadata
        .map((action) => action.id)
        .join(", ")}`,
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
      `Generated default action ${target.defaultAction} has unresolved required setup and cannot be ready_local: ${setupGate.blockingRequirements
        .map(formatOpenPondProfileSetupRequirement)
        .join("; ")}. Mark built-in/local fixture requirements ready or optional when they are satisfied, or leave the pipeline blocked until the setup is configured.`,
    );
  }
  const evalResults = JSON.parse(await readFile(evalResultsPath, "utf8")) as {
    summary?: { total?: unknown; failed?: unknown };
  };
  if (typeof evalResults.summary?.total !== "number" || evalResults.summary.total < 1) {
    throw new Error("Generated source must define at least one deterministic SDK eval.");
  }
  if (requireEvalPass && evalResults.summary.failed !== 0) {
    throw new Error("Generated source evals did not all pass.");
  }
}

function localCreatePipelinePrompt(
  snapshot: CreateImproveRun,
  target: LocalCreatePipelineTarget,
): string {
  return [
    `Apply this already-approved OpenPond ${snapshot.operation === "improve" ? "Improve" : "Create"} plan by editing the local profile repo source.`,
    "",
    "This is the source-materialization step, not another plan review. Make the file changes, inspect the existing profile shape first, and leave the repo with a valid openpond-agent-sdk source project.",
    "",
    "Hard requirements:",
    `- Current working directory is the profile repo root: ${target.workspaceRoot}`,
    `- Active profile source path relative to cwd: ${target.profileRelativePath}`,
    `- Target agent id: ${target.agentId}`,
    `- Target generated source root: ${target.sourceRootRelativePath}`,
    `- Default action to expose: ${target.defaultAction}`,
    `- For a create request, create the new SDK project under ${target.profileRelativePath}/agents/<agent-id>; do not overwrite ${target.profileRelativePath}/agent/agent.ts or unrelated existing agents.`,
    "- For an edit request, only edit the approved target agent source and shared profile registration files required for that edit.",
    `- Update openpond-profile.json and ${target.profileRelativePath}/settings/profile.yaml so the generated agent is registered, enabled, and catalog-discoverable.`,
    "- The generated source must be an actual openpond-agent-sdk project with package.json, tsconfig.json when needed, agent/agent.ts, deterministic evals, and action metadata.",
    "- Preserve the approved objective and any captured conversation context in source metadata, instructions, fixture comments, or eval intent so source readback can prove what was captured.",
    "- Treat plan.metadata.actionShape as the approved public action-shape decision when actionShapeDecisionSource is request_metadata or another explicit planner source.",
    "- If plan.metadata.actionShapeDecisionSource is default_chat_fallback, use the approved objective and captured context to choose the actual generated public actions: keep chat-only for conversational assistants, create direct actions for explicit repeatable runs/workflows/artifact transforms, and expose both when the user needs normal chat plus a repeatable catalog action.",
    "- When refining a default fallback during source materialization, encode the chosen public actions in generated SDK action metadata and evals; do not use business-example hardcoding.",
    "- Every public action must have a stable action id, label, description, input/output schema when useful, timeout policy, artifact policy, setup requirement metadata, and deterministic eval coverage.",
    "- The default action must be invocable through the local profile setup gate after checks. Do not leave built-in openpond_chat or committed local fixture/artifact requirements as unresolved required setup; mark those rows ready/satisfied or optional when the generated source already provides them.",
    "- If the approved objective names multiple capabilities or direct action ids, implement each requested public action instead of collapsing everything into a single chat-only action.",
    "- If a capability writes an artifact, declare it in the action artifact policy and assert it from at least one eval.",
    "- Package scripts must be portable from the generated source root; do not hardcode absolute machine-local paths to this repository or CLI.",
    "- Do not hardcode secrets, API keys, provider tokens, or user credentials in source, evals, traces, fixtures, or comments.",
    "- Use realistic deterministic fixture-backed behavior when external systems are unavailable. Declare setup requirements rather than pretending live integrations exist.",
    "- Run or prepare the source so these commands can pass from the target source root: inspect, build, validate, eval, and run of the default action.",
    "",
    "Approved Create request and plan:",
    JSON.stringify(
      {
        run: snapshot,
        plan: snapshot.plan,
        questions: snapshot.questions,
        workflowCapture: snapshot.workflowCapture,
      },
      null,
      2,
    ),
  ].join("\n");
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
  return value.filter((item): item is Record<string, unknown> => Boolean(asRecord(item)));
}

function traceRefFromCommandResult(value: unknown): string | null {
  const record = asRecord(value);
  const ref = stringValue(record?.traceArtifactRef);
  return ref?.startsWith(".openpond/") ? ref : null;
}

function summaryFromCommandResult(commandName: string, value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  if (!record) return null;
  if (commandName === "inspect") {
    return {
      actionCount: Array.isArray(record.actionCatalog) ? record.actionCatalog.length : null,
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

function agentIdFromSourcePlan(snapshot: CreateImproveRun): string | null {
  for (const entry of snapshot.plan?.sourcePlan ?? []) {
    const match = /^agents\/([^/]+)/.exec(entry.path);
    const normalized = normalizeAgentId(match?.[1]);
    if (normalized) return normalized;
  }
  return null;
}

function normalizeAgentId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const normalized = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || null;
}

function normalizeActionId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sourceActionIdForAgent(actionId: string, agentId: string): string {
  const prefix = `${agentId}.`;
  return actionId.startsWith(prefix) ? actionId.slice(prefix.length) || "chat" : actionId;
}

function slugFromObjective(objective: string): string {
  return (
    objective
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64)
      .replace(/-+$/g, "") || "generated-agent"
  );
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/") || ".";
}
