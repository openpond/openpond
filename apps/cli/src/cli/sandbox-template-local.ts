import { Buffer } from "node:buffer";
import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  SandboxTemplateExecutable,
  SandboxTemplateManifest,
} from "../sandbox-template/manifest";
import {
  OPENPOND_MANIFEST_FILE_NAME,
  sandboxTemplateExecutableEntries,
} from "../sandbox-template/manifest";
import {
  parseIntegerOption,
  resolveSandboxClient,
  runShellCommand,
} from "./common";
import { loadSandboxTemplateBuildPlan } from "./sandbox-template";
import {
  formatUploadedFileParams,
  joinSandboxUploadPath,
  resolveSandboxTemplateStartExecutable,
  resolveSandboxTemplateStartInput,
  runSandboxTemplateExecutable,
  uploadSandboxTemplateStartFiles,
} from "./sandbox-template-start";

export type SandboxTemplateScalarInputs = Record<string, unknown>;

export type SandboxTemplateUploadSpec = {
  inputName: string;
  multiple: boolean;
  targetPath: string;
};

export type SandboxTemplateUploadRequest = {
  inputName: string;
  localPaths: string[];
  spec: SandboxTemplateUploadSpec;
};

export type SandboxTemplateUploadedFile = {
  inputName: string;
  localPath: string;
  sandboxPath: string;
  sizeBytes: number;
};

export type LocalSandboxTemplateVolume = {
  name: string | null;
  mountPath: string;
  localPath: string;
};

export type LocalSandboxTemplateCommandResult = {
  command: string;
  cwd: string;
  status: "succeeded" | "failed" | "timed_out";
  output: string;
  exitCode: number | null;
};

export async function runSandboxTemplateLocal(
  options: Record<string, string | boolean>,
  mode: "run" | "dev"
): Promise<void> {
  const { plan, filePath, projectPath } = await loadSandboxTemplateBuildPlan(
    options
  );
  const executable = resolveSandboxTemplateLocalExecutable(
    plan.manifest,
    options,
    mode
  );
  const input = await resolveSandboxTemplateStartInput(
    plan.manifest,
    options,
    projectPath
  );
  const volumes = await prepareLocalSandboxTemplateVolumes(
    plan.manifest,
    projectPath
  );
  const setupCommands = await runLocalSandboxTemplateSetupCommands(
    plan.manifest,
    projectPath,
    options
  );
  const uploadedFiles = await prepareLocalSandboxTemplateUploads(
    input.uploadRequests,
    projectPath
  );
  const commandInput = {
    ...input.scalars,
    ...formatUploadedFileParams(uploadedFiles, input.uploadRequests),
  };
  const replay = await writeLocalSandboxTemplateReplayParams(
    projectPath,
    executable,
    commandInput
  );
  const previews = localSandboxTemplatePreviews(executable);
  if (mode === "dev" || executable.kind === "service") {
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode,
          file: filePath,
          template: plan.manifest.name,
          executable: summarizeSandboxTemplateExecutable(executable),
          volumes,
          setupCommands,
          uploadedFiles,
          input: commandInput,
          replayParamsPath: replay.paramsPath,
          previews,
          status: "starting",
        },
        null,
        2
      )
    );
    const result = await runLocalSandboxTemplateCommand(
      projectPath,
      executable,
      replay,
      {
        inherit: true,
        timeoutSeconds: executable.timeoutSeconds,
      }
    );
    if (result.status !== "succeeded") process.exitCode = 1;
    return;
  }

  const execution = await runLocalSandboxTemplateCommand(
    projectPath,
    executable,
    replay,
    {
      timeoutSeconds: executable.timeoutSeconds ?? 900,
    }
  );
  const artifacts = await collectLocalSandboxTemplateArtifacts(
    projectPath,
    executable.artifactPaths
  );
  if (execution.status !== "succeeded") process.exitCode = 1;
  console.log(
    JSON.stringify(
      {
        ok: execution.status === "succeeded",
        mode,
        file: filePath,
        template: plan.manifest.name,
        executable: summarizeSandboxTemplateExecutable(executable),
        volumes,
        setupCommands,
        uploadedFiles,
        input: commandInput,
        replayParamsPath: replay.paramsPath,
        execution,
        previews,
        artifacts,
      },
      null,
      2
    )
  );
}

export async function runSandboxTemplateExistingSandboxAction(
  options: Record<string, string | boolean>,
  rest: string[]
): Promise<void> {
  const sandboxId =
    rest[0]?.trim() ||
    (typeof options.sandboxId === "string" ? options.sandboxId.trim() : "");
  const actionName =
    rest[1]?.trim() ||
    (typeof options.action === "string" ? options.action.trim() : "") ||
    (typeof options.target === "string" ? options.target.trim() : "");
  if (!sandboxId || !actionName) {
    throw new Error(
      `usage: sandbox-template action <sandboxId> <actionName> [--file ${OPENPOND_MANIFEST_FILE_NAME}]`
    );
  }
  const { plan, filePath, projectPath } = await loadSandboxTemplateBuildPlan(
    options
  );
  const executable = resolveSandboxTemplateActionExecutable(
    plan.manifest,
    actionName
  );
  const input = await resolveSandboxTemplateStartInput(
    plan.manifest,
    options,
    projectPath
  );
  const client = await resolveSandboxClient(options);
  const uploadedFiles = await uploadSandboxTemplateStartFiles(
    client,
    sandboxId,
    input.uploadRequests
  );
  const commandInput = {
    ...input.scalars,
    ...formatUploadedFileParams(uploadedFiles, input.uploadRequests),
  };
  const execution = await runSandboxTemplateExecutable(
    client,
    sandboxId,
    executable,
    commandInput
  );
  console.log(
    JSON.stringify(
      {
        ok: true,
        file: filePath,
        sandboxId,
        executable: summarizeSandboxTemplateExecutable(executable),
        uploadedFiles,
        input: commandInput,
        execution,
        expectedArtifacts: executable.artifactPaths,
      },
      null,
      2
    )
  );
}

export function resolveSandboxTemplateLocalExecutable(
  manifest: SandboxTemplateManifest,
  options: Record<string, string | boolean>,
  mode: "run" | "dev"
): SandboxTemplateExecutable {
  if (
    mode === "dev" &&
    typeof options.target !== "string" &&
    typeof options.action !== "string" &&
    typeof options.service !== "string" &&
    typeof options.entrypoint !== "string"
  ) {
    const firstService = sandboxTemplateExecutableEntries(manifest).find(
      (candidate) => candidate.kind === "service"
    );
    if (firstService) return firstService;
  }
  return resolveSandboxTemplateStartExecutable(manifest, options);
}

export function resolveSandboxTemplateActionExecutable(
  manifest: SandboxTemplateManifest,
  actionName: string
): SandboxTemplateExecutable {
  const match = sandboxTemplateExecutableEntries(manifest).find(
    (candidate) => candidate.kind === "action" && candidate.name === actionName
  );
  if (!match) {
    const actions =
      manifest.actions.map((action) => action.name).join(", ") || "(none)";
    throw new Error(
      `manifest action not found: ${actionName}. Available actions: ${actions}`
    );
  }
  return match;
}

export function summarizeSandboxTemplateExecutable(
  executable: SandboxTemplateExecutable
): Record<string, unknown> {
  return {
    kind: executable.kind,
    name: executable.name,
    command: executable.command,
    cwd: executable.cwd ?? null,
    timeoutSeconds: executable.timeoutSeconds ?? null,
    ports: executable.ports,
    artifactPaths: executable.artifactPaths,
  };
}

export async function prepareLocalSandboxTemplateVolumes(
  manifest: SandboxTemplateManifest,
  projectPath: string
): Promise<LocalSandboxTemplateVolume[]> {
  const volumes: LocalSandboxTemplateVolume[] = [];
  for (const volume of manifest.volumes) {
    const mountPath =
      typeof volume.mountPath === "string" && volume.mountPath.trim()
        ? volume.mountPath.trim()
        : volume.name
        ? `/workspace/volumes/${volume.name}`
        : "";
    if (!mountPath) continue;
    const localPath = path.resolve(
      projectPath,
      normalizeLocalWorkspacePath(mountPath)
    );
    await fs.mkdir(localPath, { recursive: true });
    volumes.push({
      name: volume.name ?? null,
      mountPath,
      localPath,
    });
  }
  return volumes;
}

export async function runLocalSandboxTemplateSetupCommands(
  manifest: SandboxTemplateManifest,
  projectPath: string,
  options: Record<string, string | boolean>
): Promise<LocalSandboxTemplateCommandResult[]> {
  const timeoutSeconds =
    parseIntegerOption(options.setupTimeoutSeconds, "setup-timeout-seconds") ??
    900;
  const results: LocalSandboxTemplateCommandResult[] = [];
  for (const command of manifest.setup.commands) {
    const result = await runLocalShellCommandResult(command, projectPath, {
      timeoutSeconds,
    });
    results.push(result);
    if (result.status !== "succeeded") {
      throw new Error(
        `local setup command failed: ${command}\n${result.output}`
      );
    }
  }
  return results;
}

export async function prepareLocalSandboxTemplateUploads(
  requests: SandboxTemplateUploadRequest[],
  projectPath: string
): Promise<SandboxTemplateUploadedFile[]> {
  const uploaded: SandboxTemplateUploadedFile[] = [];
  for (const request of requests) {
    for (const localPath of request.localPaths) {
      const contents = await fs.readFile(localPath);
      const sandboxPath = joinSandboxUploadPath(
        request.spec.targetPath,
        path.basename(localPath)
      );
      const destination = path.resolve(
        projectPath,
        normalizeLocalWorkspacePath(sandboxPath)
      );
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(localPath, destination);
      uploaded.push({
        inputName: request.inputName,
        localPath,
        sandboxPath,
        sizeBytes: contents.byteLength,
      });
    }
  }
  return uploaded;
}

export async function writeLocalSandboxTemplateReplayParams(
  projectPath: string,
  executable: SandboxTemplateExecutable,
  input: SandboxTemplateScalarInputs
): Promise<{ paramsPath: string; encoded: string }> {
  const paramsJson = `${JSON.stringify({ input }, null, 2)}\n`;
  const encoded = Buffer.from(paramsJson, "utf8").toString("base64");
  const paramsPath = path.join(projectPath, "openpond-replay-params.json");
  await fs.writeFile(paramsPath, paramsJson, "utf8");
  if (executable.cwd) {
    const cwdParamsPath = path.join(
      projectPath,
      executable.cwd,
      "openpond-replay-params.json"
    );
    if (cwdParamsPath !== paramsPath) {
      await fs.mkdir(path.dirname(cwdParamsPath), { recursive: true });
      await fs.writeFile(cwdParamsPath, paramsJson, "utf8");
    }
  }
  return { paramsPath, encoded };
}

export async function runLocalSandboxTemplateCommand(
  projectPath: string,
  executable: SandboxTemplateExecutable,
  replay: { encoded: string },
  options: { timeoutSeconds?: number; inherit?: boolean } = {}
): Promise<LocalSandboxTemplateCommandResult> {
  const cwd = executable.cwd
    ? path.resolve(projectPath, executable.cwd)
    : projectPath;
  return runLocalShellCommandResult(executable.command, cwd, {
    env: {
      OPENPOND_REPLAY_PARAMS_BASE64: replay.encoded,
    },
    timeoutSeconds: options.timeoutSeconds,
    inherit: options.inherit,
  });
}

export async function runLocalShellCommandResult(
  command: string,
  cwd: string,
  options: {
    env?: Record<string, string>;
    timeoutSeconds?: number;
    inherit?: boolean;
  } = {}
): Promise<LocalSandboxTemplateCommandResult> {
  const result = await runShellCommand(command, {
    cwd,
    env: options.env,
    timeoutSeconds: options.timeoutSeconds,
    inherit: options.inherit,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("");
  return {
    command,
    cwd,
    status: result.timedOut
      ? "timed_out"
      : result.code === 0
      ? "succeeded"
      : "failed",
    output,
    exitCode: result.code,
  };
}

export function localSandboxTemplatePreviews(
  executable: SandboxTemplateExecutable
): Array<Record<string, unknown>> {
  return executable.ports.map((port) => ({
    port: port.port,
    label: port.label ?? null,
    access: port.access,
    url: `http://127.0.0.1:${port.port}${port.path}`,
  }));
}

export async function collectLocalSandboxTemplateArtifacts(
  projectPath: string,
  artifactPaths: string[]
): Promise<Array<{ path: string; exists: boolean; sizeBytes: number | null }>> {
  const artifacts = [];
  for (const artifactPath of artifactPaths) {
    const localPath = path.resolve(
      projectPath,
      normalizeLocalWorkspacePath(artifactPath)
    );
    try {
      const stat = await fs.stat(localPath);
      artifacts.push({
        path: artifactPath,
        exists: stat.isFile(),
        sizeBytes: stat.size,
      });
    } catch {
      artifacts.push({ path: artifactPath, exists: false, sizeBytes: null });
    }
  }
  return artifacts;
}

export function normalizeLocalWorkspacePath(value: string): string {
  const normalized = value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/workspace\//, "")
    .replace(/^workspace\//, "")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
  if (
    !normalized ||
    normalized.split("/").some((segment) => segment === ".." || segment === "")
  ) {
    throw new Error(`invalid workspace path: ${value}`);
  }
  return normalized;
}
