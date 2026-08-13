import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  DEFAULT_PROJECT_ACTION_OUTPUT_DIRECTORY,
  buildProjectActions,
} from "./build.js";
import {
  loadProjectActionConfiguration,
  resolveProjectActionRuntime,
} from "./configuration.js";
import type {
  LocalProjectActionRunner,
  ProjectActionBuildResult,
  ProjectActionRegistry,
  ProjectActionRunRequest,
  ProjectActionRunResult,
  ProjectActionRunnerOptions,
} from "./types.js";
import { validateProjectActionRunSetup } from "./setup.js";

const localConcurrency = new Map<string, { active: number; waiting: Array<() => void> }>();

export function createLocalActionRunner(
  options: ProjectActionRunnerOptions,
): LocalProjectActionRunner {
  const projectRoot = path.resolve(options.projectRoot);
  const buildPolicy = options.build ?? "if-missing";
  let currentBuild: ProjectActionBuildResult | null = null;

  const ensureBuild = async (): Promise<ProjectActionBuildResult> => {
    if (buildPolicy === "always") return runBuild();
    if (currentBuild) return currentBuild;
    if (buildPolicy === "never" || buildPolicy === "if-missing") {
      const configuration = await loadProjectActionConfiguration(projectRoot);
      const outputDirectory = path.resolve(
        projectRoot,
        options.outputDirectory ?? configuration.outputDirectory ?? DEFAULT_PROJECT_ACTION_OUTPUT_DIRECTORY,
      );
      const loaded = await loadBuild(projectRoot, outputDirectory);
      if (loaded) return (currentBuild = loaded);
      if (buildPolicy === "never") {
        throw new Error(`Project Actions have not been built in ${outputDirectory}.`);
      }
    }
    return runBuild();
  };
  const runBuild = async () => {
    currentBuild = await buildProjectActions({
      projectRoot,
      sourceDirectory: options.sourceDirectory,
      outputDirectory: options.outputDirectory,
    });
    return currentBuild;
  };

  return {
    build: runBuild,
    async catalog() {
      return (await ensureBuild()).registry;
    },
    async run<TOutput>(request: ProjectActionRunRequest) {
      const built = await ensureBuild();
      const catalogAction = built.registry.actions.find((action) => action.id === request.actionId);
      if (!catalogAction) throw new Error(`Unknown Project Action: ${request.actionId}`);
      const configuredRuntime = resolveProjectActionRuntime(
        await loadProjectActionConfiguration(projectRoot),
      );
      const resolvedRequest: ProjectActionRunRequest = {
        ...request,
        environment: {
          ...configuredRuntime.environment,
          ...(request.environment ?? {}),
        },
        connections: {
          ...configuredRuntime.connections,
          ...(request.connections ?? {}),
        },
      };
      await validateProjectActionRunSetup(projectRoot, catalogAction.setupRequirements, resolvedRequest);
      const runId = request.runId?.trim() || randomUUID();
      const actionOutputDirectory = path.resolve(
        request.outputDirectory ?? path.join(projectRoot, ".openpond", "outputs", runId),
      );
      assertWithinProject(projectRoot, actionOutputDirectory, "Project Action output directory");
      await fs.mkdir(actionOutputDirectory, { recursive: true });
      const release = await acquireLocalActionSlot(
        `${projectRoot}\0${request.actionId}`,
        catalogAction.implementation.concurrency,
        resolvedRequest.signal,
      );
      const responseFile = path.join(built.outputDirectory, `.run-${randomUUID()}.json`);
      const startedAt = Date.now();
      let childResult: Awaited<ReturnType<typeof executeChild>>;
      let payload: {
          ok: true;
          output: TOutput;
          traces: ProjectActionRunResult["traces"];
          outputs: ProjectActionRunResult["outputs"];
        };
      try {
        childResult = await executeChild({
          runnerPath: built.runnerPath,
          cwd: projectRoot,
          signal: resolvedRequest.signal,
          request: {
            actionId: request.actionId,
            input: resolvedRequest.input ?? {},
            runId,
            idempotencyKey: resolvedRequest.idempotencyKey ?? null,
            timeoutMs: resolvedRequest.timeoutMs,
            projectRoot,
            outputDirectory: actionOutputDirectory,
            responseFile,
            environment: resolvedRequest.environment ?? {},
            connections: resolvedRequest.connections ?? {},
          },
        });
        payload = JSON.parse(await fs.readFile(responseFile, "utf8")) as typeof payload;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(redactRuntimeValues(message, resolvedRequest));
      } finally {
        await fs.rm(responseFile, { force: true }).catch(() => undefined);
        release();
      }
      return {
        runId,
        actionId: request.actionId,
        status: "succeeded",
        output: payload.output,
        stdout: redactRuntimeValues(childResult.stdout, resolvedRequest),
        stderr: redactRuntimeValues(childResult.stderr, resolvedRequest),
        traces: redactRuntimeValue(payload.traces, resolvedRequest),
        outputs: redactRuntimeValue(payload.outputs, resolvedRequest),
        outputDirectory: actionOutputDirectory,
        durationMs: Date.now() - startedAt,
      } satisfies ProjectActionRunResult<TOutput>;
    },
  };
}

async function acquireLocalActionSlot(
  key: string,
  limit: number | null,
  signal?: AbortSignal,
): Promise<() => void> {
  if (limit === null) return () => undefined;
  const state = localConcurrency.get(key) ?? { active: 0, waiting: [] };
  localConcurrency.set(key, state);
  if (state.active >= limit) {
    await new Promise<void>((resolve, reject) => {
      const resume = () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        const index = state.waiting.indexOf(resume);
        if (index >= 0) state.waiting.splice(index, 1);
        reject(signal?.reason instanceof Error ? signal.reason : new Error("Project Action was cancelled."));
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      state.waiting.push(resume);
      signal?.addEventListener("abort", abort, { once: true });
    });
  } else {
    state.active += 1;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = state.waiting.shift();
    if (next) {
      next();
      return;
    }
    state.active -= 1;
    if (state.active === 0 && state.waiting.length === 0) localConcurrency.delete(key);
  };
}

async function loadBuild(
  projectRoot: string,
  outputDirectory: string,
): Promise<ProjectActionBuildResult | null> {
  const manifestPath = path.join(outputDirectory, "build-manifest.json");
  const registryPath = path.join(outputDirectory, "action-registry.json");
  const [manifestText, registryText] = await Promise.all([
    fs.readFile(manifestPath, "utf8").catch(() => null),
    fs.readFile(registryPath, "utf8").catch(() => null),
  ]);
  if (!manifestText || !registryText) return null;
  const manifest = JSON.parse(manifestText) as ProjectActionBuildResult["manifest"];
  const registry = JSON.parse(registryText) as ProjectActionRegistry;
  return {
    projectRoot,
    outputDirectory,
    bundlePath: path.join(outputDirectory, manifest.bundleFile),
    runnerPath: path.join(outputDirectory, manifest.runnerFile),
    registryPath,
    manifestPath,
    registry,
    manifest,
  };
}

function redactRuntimeValues(value: string, request: ProjectActionRunRequest): string {
  let redacted = value;
  for (const secret of runtimeStringValues(request)) {
    if (secret.length >= 4) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

function redactRuntimeValue<T>(value: T, request: ProjectActionRunRequest): T {
  const serialized = JSON.stringify(value);
  return JSON.parse(redactRuntimeValues(serialized, request)) as T;
}

function runtimeStringValues(request: ProjectActionRunRequest): string[] {
  const values = new Set<string>(Object.values(request.environment ?? {}));
  const visit = (value: unknown) => {
    if (typeof value === "string") values.add(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(request.connections ?? {});
  return [...values].filter(Boolean).sort((left, right) => right.length - left.length);
}

function executeChild(input: {
  runnerPath: string;
  cwd: string;
  signal?: AbortSignal;
  request: Record<string, unknown>;
}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (input.signal?.aborted) {
      reject(input.signal.reason instanceof Error ? input.signal.reason : new Error("Project Action was cancelled."));
      return;
    }
    let requestJson: string;
    try {
      requestJson = JSON.stringify(input.request);
    } catch (error) {
      reject(new Error(`Project Action request is not serializable: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    const child = spawn(process.execPath, [input.runnerPath], {
      cwd: input.cwd,
      env: minimalEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const abort = () => child.kill("SIGTERM");
    input.signal?.addEventListener("abort", abort, { once: true });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      input.signal?.removeEventListener("abort", abort);
      if (input.signal?.aborted) {
        reject(input.signal.reason instanceof Error ? input.signal.reason : new Error("Project Action was cancelled."));
        return;
      }
      if (code !== 0) {
        reject(new Error(`Project Action process failed (${code ?? signal ?? "unknown"}): ${stderr.trim() || stdout.trim()}`));
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin.end(requestJson);
  });
}

function assertWithinProject(projectRoot: string, target: string, label: string): void {
  const relative = path.relative(projectRoot, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside the Project root.`);
  }
}

function minimalEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "SystemRoot", "WINDIR", "TMPDIR", "TEMP", "TMP"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

export { buildProjectActions } from "./build.js";
export {
  loadProjectActionConfiguration,
  PROJECT_ACTION_CONFIG_PATH,
  resolveProjectActionRuntime,
} from "./configuration.js";
export type {
  LocalProjectActionRunner,
  ProjectActionBuildManifest,
  ProjectActionBuildResult,
  ProjectActionCatalogEntry,
  ProjectActionRegistry,
  ProjectActionRunRequest,
  ProjectActionRunResult,
  ProjectActionRunnerOptions,
} from "./types.js";
