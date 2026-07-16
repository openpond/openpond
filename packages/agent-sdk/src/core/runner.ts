import { spawn } from "node:child_process";
import path from "node:path";

import type {
  ActionCatalogEntry,
  AgentChatInput,
  AgentChatResult,
  AgentContext,
  AgentProjectDefinition,
  EvalContext,
  IntentDefinition,
  IntentRouterDefinition,
  WorkflowDefinition,
} from "../index";
import { ARTIFACT_SCHEMAS, SDK_SCHEMA_VERSION, traceDir } from "./constants";
import { actionId, localAgentId, normalizeInput, remoteAgentId, toolName, workflowName } from "./schema";
import type { ExecuteActionOptions, RunState } from "./types";
import { writeText } from "./files";
import { inspectActions } from "./manifest";

export function createRunState(): RunState {
  return { artifacts: [], assertions: [], commands: [], events: [] };
}

export async function executeAction(
  project: AgentProjectDefinition,
  actionName: string,
  input: AgentChatInput,
  state: RunState,
  options: ExecuteActionOptions = {},
): Promise<AgentChatResult> {
  const action = project.actions.find((candidate) => actionId(candidate) === actionName || candidate.name === actionName);
  if (!action) throw new Error(`Unknown action: ${actionName}`);
  const selectedActionId = actionId(action);
  state.events.push(traceEvent("action.started", { action: selectedActionId, requestedAction: actionName }));
  try {
    throwIfAborted(options.signal);
    const ctx = createAgentContext(project, state);
    const run = () => executeActionTarget(project, ctx, action, input, state);
    const result = await withExecutionGuards(
      run,
      {
        actionName: selectedActionId,
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? timeoutSecondsToMs(action.timeoutSeconds),
      },
    );
    state.events.push(traceEvent("action.completed", { action: selectedActionId, intent: result.intent }));
    return result;
  } catch (error) {
    state.events.push(traceEvent("action.failed", { action: selectedActionId, error: errorMessage(error) }));
    throw error;
  }
}

export async function runAction(
  project: AgentProjectDefinition,
  actionName: string,
  input?: Record<string, unknown>,
  options: ExecuteActionOptions = {},
): Promise<{ result: AgentChatResult; state: RunState; actionCatalog: ActionCatalogEntry[] }> {
  const state = createRunState();
  const actionCatalog = inspectActions(project);
  state.events.push(traceEvent("action.catalog.available", {
    actions: actionCatalog.map((action) => action.id),
  }));
  const result = await executeAction(project, actionName, normalizeInput(input), state, options);
  return { result, state, actionCatalog };
}

export async function runChatAction(
  project: AgentProjectDefinition,
  input?: Record<string, unknown>,
  options: ExecuteActionOptions = {},
): Promise<{ result: AgentChatResult; state: RunState; actionCatalog: ActionCatalogEntry[] }> {
  return runAction(project, project.defaultAction ?? "chat", input, options);
}

export async function runEval(
  project: AgentProjectDefinition,
): Promise<{ state: RunState; results: Array<{ name: string; status: "passed" | "failed"; error?: string }> }> {
  const state = createRunState();
  const results = [];
  for (const evaluation of project.evals ?? []) {
    try {
      await tracedSpan(state, "eval", evaluation.name, async () => {
        await evaluation.run(createEvalContext(project, state));
      });
      results.push({ name: evaluation.name, status: "passed" as const });
    } catch (error) {
      results.push({ name: evaluation.name, status: "failed" as const, error: errorMessage(error) });
    }
  }
  return { state, results };
}

function timeoutSecondsToMs(timeoutSeconds: number | undefined): number | undefined {
  return timeoutSeconds === undefined ? undefined : Math.max(0, timeoutSeconds * 1_000);
}

async function withExecutionGuards<TResult>(
  run: () => Promise<TResult>,
  options: { actionName: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<TResult> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    const candidates: Promise<TResult>[] = [run()];
    if (options.timeoutMs !== undefined) {
      candidates.push(new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`Action ${options.actionName} timed out after ${options.timeoutMs}ms.`)),
          options.timeoutMs,
        );
      }));
    }
    if (options.signal) {
      candidates.push(new Promise((_, reject) => {
        abort = () => reject(new Error(`Action ${options.actionName} was canceled.`));
        options.signal?.addEventListener("abort", abort, { once: true });
      }));
    }
    return await Promise.race(candidates);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (options.signal && abort) options.signal.removeEventListener("abort", abort);
  }
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw new Error("Action was canceled.");
}

export function createEvalContext(project: AgentProjectDefinition, state: RunState): EvalContext {
  let lastResult: AgentChatResult | null = null;
  const assert = (name: string, check: () => void) => {
    try {
      check();
      state.assertions.push({ name, status: "passed" });
    } catch (error) {
      const message = errorMessage(error);
      state.assertions.push({ name, status: "failed", message });
      throw error;
    }
  };
  return {
    async send(input) {
      const actionName = project.defaultAction ?? project.actions[0]?.name;
      if (!actionName) throw new Error("No default action available for eval send.");
      lastResult = await executeAction(project, actionName, normalizeInput(input), state);
      return lastResult;
    },
    async runAction(actionName, input) {
      lastResult = await executeAction(project, actionName, normalizeInput(input), state);
      return lastResult;
    },
    expectIntent(name) {
      assert(`intent:${name}`, () => {
        if (lastResult?.intent !== name) throw new Error(`Expected intent ${name}, received ${lastResult?.intent ?? "none"}.`);
      });
    },
    expectTextIncludes(text) {
      assert(`text_includes:${text}`, () => {
        if (!(lastResult?.text ?? "").toLowerCase().includes(text.toLowerCase())) {
          throw new Error(`Expected response text to include "${text}".`);
        }
      });
    },
    expectArtifact(ref) {
      assert(`artifact:${ref}`, () => {
        const refs = new Set([...(lastResult?.artifactRefs ?? []), ...state.artifacts.map((artifact) => artifact.ref)]);
        if (!refs.has(ref)) throw new Error(`Expected artifact ${ref}.`);
      });
    },
    expectTraceEvent(name) {
      assert(`trace:${name}`, () => {
        if (!state.events.some((event) => event.name === name)) throw new Error(`Expected trace event ${name}.`);
      });
    },
  };
}

export async function writeTrace(
  cwd: string,
  name: string,
  state: RunState,
  artifactDir?: string,
): Promise<string> {
  const safeName = name.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "trace";
  const relativePath = path.join(traceDir(artifactDir), `${safeName}-${Date.now()}.jsonl`);
  const lines = [
    ...state.events.map((event) => traceEntry("event", event)),
    ...state.artifacts.map((artifact) => traceEntry("artifact", artifact)),
    ...state.commands.map((command) => traceEntry("command", command)),
  ].map((entry) => JSON.stringify(entry));
  await writeText(cwd, relativePath, `${lines.join("\n")}\n`);
  return relativePath;
}

function traceEntry(kind: "event" | "artifact" | "command", value: object) {
  return {
    schemaVersion: SDK_SCHEMA_VERSION,
    schema: ARTIFACT_SCHEMAS.trace,
    kind,
    ...redactObject(value),
  };
}

function createAgentContext(project: AgentProjectDefinition, state: RunState): AgentContext {
  const ctx: AgentContext = {
    trace: {
      event(name, payload) {
        state.events.push(traceEvent(name, payload));
      },
      artifact(ref, metadata) {
        state.artifacts.push({ ref, metadata: redactRecord(metadata) });
        state.events.push(traceEvent("artifact.created", { ref, ...(metadata ? { metadata: redactRecord(metadata) } : {}) }));
      },
      async span(kind, name, run, payload) {
        return tracedSpan(state, kind, name, run, payload);
      },
    },
    step(name, run) {
      return tracedSpan(state, "step", name, run);
    },
    model(name, run) {
      return tracedSpan(state, "model", name, run);
    },
    tool(name, run) {
      return tracedSpan(state, "tool", name, run);
    },
    action(name, run) {
      return tracedSpan(state, "action", name, run);
    },
    async loadSkill(name) {
      const skill = (project.skills ?? []).find((candidate) => candidate.name === name);
      if (!skill) throw new Error(`Unknown skill: ${name}`);
      state.events.push(traceEvent("skill.loaded", { skill: name, description: skill.description ?? null }));
      return { name: skill.name, description: skill.description ?? null };
    },
    async runCommand(command, options) {
      state.commands.push({ command, options: redactRecord(options) });
      state.events.push(traceEvent("command.started", { command }));
      const cwd = typeof options?.cwd === "string" && options.cwd.trim()
        ? options.cwd.trim()
        : process.cwd();
      const optionEnv = options?.env && typeof options.env === "object" && !Array.isArray(options.env)
        ? Object.fromEntries(
            Object.entries(options.env).flatMap(([key, value]) =>
              typeof value === "string" ? [[key, value]] : [],
            ),
          )
        : {};
      try {
        const { exitCode, stdout, stderr } = await runShellCommand(command, cwd, {
          ...process.env,
          ...optionEnv,
        });
        const status = exitCode === 0 ? "succeeded" : "failed";
        state.events.push(traceEvent("command.completed", {
          command,
          status,
          exitCode,
        }));
        return { status, stdout, stderr };
      } catch (error) {
        const stderr = errorMessage(error);
        state.events.push(traceEvent("command.completed", {
          command,
          status: "failed",
          error: stderr,
        }));
        return { status: "failed", stderr };
      }
    },
    async workflow(name, input) {
      const workflow = (project.workflows ?? []).find((candidate) => candidate.name === name);
      if (!workflow) throw new Error(`Unknown workflow: ${name}`);
      return tracedSpan(state, "workflow", name, async () => {
        const result = await workflow.run(createAgentContext(project, state), input as Record<string, unknown>);
        return result as never;
      }, { workflow: name });
    },
  };
  return ctx;
}

function runShellCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-lc", command], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({
        exitCode: code ?? (signal ? 1 : 0),
        stdout,
        stderr,
      });
    });
  });
}

async function executeActionTarget(
  project: AgentProjectDefinition,
  ctx: AgentContext,
  action: AgentProjectDefinition["actions"][number],
  input: AgentChatInput,
  state: RunState,
): Promise<AgentChatResult> {
  if (action.target.kind === "chat") {
    const actionCatalog = inspectActions(project).filter((entry) => entry.id !== actionId(action));
    state.events.push(traceEvent("chat.action.started", {
      action: actionId(action),
      allowedActions: action.target.allowedActions ?? actionCatalog.map((entry) => entry.id),
    }));
    if (!action.target.run) {
      return {
        text: "",
        intent: "chat",
        metadata: {
          actionCatalog,
          modelPolicy: action.model ?? project.model ?? { provider: "openpond-managed" },
        },
      };
    }
    return action.target.run(ctx, input, actionCatalog);
  }
  if (action.target.kind === "workflow") {
    return executeWorkflowTarget(ctx, action.target.workflow, input);
  }
  if (action.target.kind === "intent-router") {
    return executeRouterTarget(ctx, action.target.router, input, state);
  }
  if (action.target.kind === "local-agent") {
    const agentId = localAgentId(action.target.agent);
    const agent = typeof action.target.agent === "string"
      ? (project.agents ?? []).find((candidate) => candidate.id === agentId)
      : action.target.agent;
    if (!agent) throw new Error(`Unknown local agent: ${agentId}`);
    return tracedSpan(state, "action", agentId, () => agent.run(ctx, input), { implementation: "local-agent" });
  }
  if (action.target.kind === "tool") {
    const name = toolName(action.target.tool);
    const tool = typeof action.target.tool === "string"
      ? (project.tools ?? []).find((candidate) => candidate.name === name)
      : action.target.tool;
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    if (!tool.run) throw new Error(`Tool ${name} is inspect-only and cannot be executed directly.`);
    return tracedSpan(state, "tool", name, () => tool.run!(ctx, input), { implementation: "tool" });
  }
  const agentId = remoteAgentId(action.target.remoteAgent);
  state.events.push(traceEvent("remote-agent.dispatch.requested", {
    action: actionId(action),
    remoteAgentId: agentId,
  }));
  throw new Error(`Remote agent ${agentId} requires the OpenPond platform runtime.`);
}

async function tracedSpan<TResult>(
  state: RunState,
  kind: "workflow" | "step" | "model" | "tool" | "action" | "eval" | "skill",
  name: string,
  run: () => Promise<TResult>,
  payload?: Record<string, unknown>,
): Promise<TResult> {
  const startedAt = Date.now();
  state.events.push(traceEvent(`${kind}.started`, { name, ...payload }));
  try {
    const result = await run();
    state.events.push(traceEvent(`${kind}.completed`, {
      name,
      durationMs: Date.now() - startedAt,
    }));
    return result;
  } catch (error) {
    state.events.push(traceEvent(`${kind}.failed`, {
      name,
      durationMs: Date.now() - startedAt,
      error: errorMessage(error),
    }));
    throw error;
  }
}

async function executeWorkflowTarget(
  ctx: AgentContext,
  workflow: WorkflowDefinition | string,
  input: Record<string, unknown>,
): Promise<AgentChatResult> {
  return ctx.workflow(workflowName(workflow), input);
}

async function executeRouterTarget(
  ctx: AgentContext,
  router: IntentRouterDefinition | string,
  input: AgentChatInput,
  state: RunState,
): Promise<AgentChatResult> {
  if (typeof router === "string") throw new Error(`String router targets are inspect-only in the local runner: ${router}`);
  state.events.push(traceEvent("intent.router.started", { intents: router.intents.map((intent) => intent.name) }));
  const selected = await selectIntent(router, input);
  state.events.push(traceEvent("intent.selected", { intent: selected.name }));
  const result = await selected.run(ctx, input);
  state.events.push(traceEvent("intent.completed", { intent: selected.name }));
  return result;
}

async function selectIntent(router: IntentRouterDefinition, input: AgentChatInput): Promise<IntentDefinition> {
  for (const intent of router.intents) {
    if (intent.when && await intent.when(input)) return intent;
  }
  return router.defaultIntent;
}

function traceEvent(name: string, payload?: Record<string, unknown>) {
  return { name, payload: redactRecord(payload), timestamp: new Date().toISOString() };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redactRecord(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return value ? redactObject(value) : undefined;
}

function redactObject(value: object): Record<string, unknown> {
  return redactValue(value) as Record<string, unknown>;
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = isSecretLikeKey(key) ? "[redacted]" : redactValue(entry);
  }
  return result;
}

function isSecretLikeKey(key: string): boolean {
  return /api[_-]?key|authorization|cookie|password|secret|token/i.test(key);
}
