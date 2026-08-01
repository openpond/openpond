import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  AgentPackageOutputRefSchema,
  AgentPackageSchema,
  WORK_AGENT_PACKAGE_MAX_SOURCE_BYTES,
  type AgentPackage,
  type AgentPackageAction,
  type AgentPackageOutputRef,
  type AgentPackageReceipt,
  type RuntimeEvent,
  type Session,
} from "@openpond/contracts";
import { sandboxRequestPayload } from "../openpond/sandboxes.js";

const AGENT_PACKAGE_SCHEMA = "openpond.agent-package.v1";
const MAX_SOURCE_FILES = 1_000;
const REQUIRED_ARTIFACTS = [
  ".openpond/agent-manifest.json",
  ".openpond/action-registry.json",
  ".openpond/eval-results.json",
  ".openpond/validator-report.md",
] as const;

type SandboxRequest = typeof sandboxRequestPayload;

export type PrepareWorkAgentInput = {
  session: Session;
  directory: string;
  template: "blank-agent" | "customer-reply-agent" | "integration-heavy-agent";
};

export type SaveWorkAgentPackageInput = {
  session: Session;
  sourceTurnId: string;
  directory: string;
  agentId?: string | null;
  title?: string | null;
};

export function createWorkAgentPackageService(input: {
  deviceId: string;
  storeDir: string;
  runtimeEventsForSession: (sessionId: string) => Promise<RuntimeEvent[]>;
  loadAgentSdkArchive: () => Promise<Buffer>;
  installAgentPackage?: (input: {
    agentPackage: AgentPackage;
    overwrite?: boolean;
  }) => Promise<unknown>;
  sandboxRequest?: SandboxRequest;
}) {
  const packageRoot = path.join(input.storeDir, "work", "agent-packages");
  const sandboxRequest = input.sandboxRequest ?? sandboxRequestPayload;

  async function prepareWorkAgent(request: PrepareWorkAgentInput) {
    const sandboxId = requireWorkSandbox(request.session);
    const directory = normalizeAgentDirectory(request.directory);
    const archive = await input.loadAgentSdkArchive();
    await sandboxRequest({
      type: "upload_file",
      sandboxId,
      payload: {
        path: "inputs/openpond-agent-sdk.tgz",
        contentsBase64: archive.toString("base64"),
      },
    });
    const command = [
      "cd work",
      "npm install --ignore-scripts --no-audit --no-fund --no-package-lock --no-save ../inputs/openpond-agent-sdk.tgz",
      `npx openpond-agent init ${request.template} --cwd ${directory}`,
      `pnpm --dir ${directory} install --ignore-scripts --no-frozen-lockfile`,
    ].join(" && ");
    const result = await sandboxRequest({
      type: "exec",
      sandboxId,
      payload: {
        command,
        timeoutSeconds: 600,
      },
    });
    assertSandboxCommandPassed(result, "Agent SDK setup");
    return {
      directory,
      template: request.template,
      sdkArchiveSha256: sha256(archive),
    };
  }

  async function saveWorkAgentPackage(
    request: SaveWorkAgentPackageInput
  ): Promise<{
    outputRef: AgentPackageOutputRef;
    artifact: {
      artifactRef: string;
      path: string;
      title: string;
      contentType: "application/vnd.openpond.agent-package+json";
      sizeBytes: number;
    };
  }> {
    const sandboxId = requireWorkSandbox(request.session);
    const directory = normalizeAgentDirectory(request.directory);
    const validationResult = await sandboxRequest({
      type: "exec",
      sandboxId,
      payload: {
        command: [
          "cd work",
          `npx openpond-agent build --cwd ${directory}`,
          `npx openpond-agent validate --json --cwd ${directory}`,
          `npx openpond-agent eval --json --cwd ${directory}`,
        ].join(" && "),
        timeoutSeconds: 900,
      },
    });
    assertSandboxCommandPassed(validationResult, "Agent validation and evals");

    const files = await readAgentSourceFiles({
      sandboxId,
      root: `work/${directory}`,
      sandboxRequest,
    });
    const fileMap = new Map(files.map((file) => [file.path, file]));
    for (const required of REQUIRED_ARTIFACTS) {
      if (!fileMap.has(required)) {
        throw new Error(
          `Validated Agent is missing required SDK artifact ${required}.`
        );
      }
    }

    const manifest = jsonObjectFile(fileMap, ".openpond/agent-manifest.json");
    if (manifest.schema !== "openpond.agent.manifest.v1") {
      throw new Error("Agent manifest has an unsupported schema.");
    }
    const actionRegistry = jsonObjectFile(
      fileMap,
      ".openpond/action-registry.json"
    );
    if (actionRegistry.schema !== "openpond.agent.action-registry.v1") {
      throw new Error("Agent action registry has an unsupported schema.");
    }
    const evalResults = jsonObjectFile(fileMap, ".openpond/eval-results.json");
    if (evalResults.schema !== "openpond.agent.eval-results.v1") {
      throw new Error("Agent eval results have an unsupported schema.");
    }
    const publishGate = asRecord(evalResults.publishGate);
    if (publishGate.status !== "passed") {
      throw new Error("Agent eval publish gate did not pass.");
    }

    const actions = agentPackageActions(actionRegistry.actions, manifest);
    if (actions.length === 0) {
      throw new Error("Agent package must expose at least one action.");
    }
    const project = asRecord(manifest.project);
    const inferredTitle = stringValue(project.name) || "OpenPond Agent";
    const title = safeTitle(request.title || inferredTitle);
    const agentId = safeAgentId(request.agentId || inferredTitle);
    const runtime = asRecord(manifest.runtime);
    const receipts = packageReceipts(fileMap, evalResults);
    const canonical = {
      schema: AGENT_PACKAGE_SCHEMA,
      agentId,
      title,
      source: {
        files,
        totalSizeBytes: files.reduce(
          (total, file) => total + file.sizeBytes,
          0
        ),
      },
      manifest,
      actions,
      runtimeRequirements: {
        base: stringValue(runtime.base) || "node-bun-workspace",
        resources: asRecord(manifest.resources),
        modelPolicy: nullableRecord(manifest.modelPolicy),
        setup: nullableRecord(manifest.setup),
      },
      receipts,
    };
    const digest = sha256(Buffer.from(stableStringify(canonical), "utf8"));
    const versionId = `agent-${digest.slice(0, 20)}`;
    const agentPackage = AgentPackageSchema.parse({
      ...canonical,
      versionId,
      digest,
    });
    const packageBytes = Buffer.from(
      `${stableStringify(agentPackage, 2)}\n`,
      "utf8"
    );
    const packageDirectory = path.join(packageRoot, digest);
    const destination = path.join(packageDirectory, "agent-package.json");
    await fs.mkdir(packageDirectory, { recursive: true, mode: 0o700 });
    await writeImmutablePackage(destination, packageBytes);

    const identity = await nextPackageOutputIdentity({
      runtimeEventsForSession: input.runtimeEventsForSession,
      sessionId: request.session.id,
      title,
    });
    const validationReceiptIds = receipts
      .filter((receipt) => receipt.kind === "sdk_validation")
      .map((receipt) => receipt.id);
    const evalReceiptIds = receipts
      .filter((receipt) => receipt.kind === "sdk_eval")
      .map((receipt) => receipt.id);
    const outputRef = AgentPackageOutputRefSchema.parse({
      kind: "agent_package",
      id: identity.id,
      title,
      sourceTaskId: request.session.id,
      sourceTurnId: request.sourceTurnId,
      revision: identity.revision,
      createdAt: new Date().toISOString(),
      agentId,
      versionId,
      digest,
      packageFileId: `${versionId}:package`,
      manifestFileId: `${versionId}:manifest`,
      actions,
      runtimeRequirements: canonical.runtimeRequirements,
      validationReceiptIds,
      evalReceiptIds,
      sourceFileCount: files.length,
      sourceSizeBytes: canonical.source.totalSizeBytes,
      location: {
        kind: "local",
        path: destination,
        deviceId: input.deviceId,
      },
      validation: [
        {
          kind: "test",
          status: "passed",
          label: "Agent SDK validation passed",
          ref: validationReceiptIds[0],
        },
        {
          kind: "test",
          status: "passed",
          label: "Agent SDK eval publish gate passed",
          ref: evalReceiptIds[0],
        },
      ],
    });
    return {
      outputRef,
      artifact: {
        artifactRef: destination,
        path: destination,
        title: `${agentId}.agent-package.json`,
        contentType: "application/vnd.openpond.agent-package+json",
        sizeBytes: packageBytes.byteLength,
      },
    };
  }

  async function promoteWorkAgentPackage(request: {
    session: Session;
    outputId: string;
    revision?: number | null;
    overwrite?: boolean;
  }) {
    if (!input.installAgentPackage) {
      throw new Error("Local Agent package installation is not configured.");
    }
    if (request.session.experience !== "work") {
      throw new Error("Only Work tasks can install Work Agent packages.");
    }
    const events = await input.runtimeEventsForSession(request.session.id);
    const outputRef = findAgentPackageOutputById(
      events,
      request.outputId,
      request.revision
    );
    if (!outputRef) throw new Error("Agent package output not found.");
    if (outputRef.location.kind !== "local") {
      throw new Error("This Agent package is not stored on this device.");
    }
    const resolvedPackageRoot = path.resolve(packageRoot);
    const target = path.resolve(outputRef.location.path);
    if (!target.startsWith(`${resolvedPackageRoot}${path.sep}`)) {
      throw new Error("Agent package path is outside managed local storage.");
    }
    const bytes = await fs.readFile(target);
    const agentPackage = AgentPackageSchema.parse(
      JSON.parse(bytes.toString("utf8"))
    );
    if (
      agentPackage.digest !== outputRef.digest ||
      agentPackage.versionId !== outputRef.versionId ||
      agentPackage.agentId !== outputRef.agentId
    ) {
      throw new Error("Saved Agent package no longer matches its OutputRef.");
    }
    return input.installAgentPackage({
      agentPackage,
      overwrite: request.overwrite === true,
    });
  }

  return {
    packageRoot,
    prepareWorkAgent,
    promoteWorkAgentPackage,
    saveWorkAgentPackage,
  };
}

async function readAgentSourceFiles(input: {
  sandboxId: string;
  root: string;
  sandboxRequest: SandboxRequest;
}) {
  const listed = asRecord(
    await input.sandboxRequest({
      type: "list_files",
      sandboxId: input.sandboxId,
      payload: {
        path: input.root,
        recursive: true,
        maxEntries: MAX_SOURCE_FILES + 1,
      },
    })
  );
  const entries = Array.isArray(listed.files) ? listed.files : [];
  const paths = entries
    .map(asRecord)
    .filter((entry) => entry.type === "file")
    .map((entry) => relativeAgentFilePath(entry.path, input.root))
    .filter((filePath): filePath is string => Boolean(filePath))
    .filter((filePath) => !excludedAgentFile(filePath));
  const uniquePaths = [...new Set(paths)].sort();
  if (uniquePaths.length === 0) {
    throw new Error("Agent source directory is empty.");
  }
  if (uniquePaths.length > MAX_SOURCE_FILES) {
    throw new Error(
      `Agent source exceeds the ${MAX_SOURCE_FILES.toLocaleString()} file limit.`
    );
  }

  let totalSizeBytes = 0;
  const files: AgentPackage["source"]["files"] = [];
  for (const filePath of uniquePaths) {
    const remainingBytes = WORK_AGENT_PACKAGE_MAX_SOURCE_BYTES - totalSizeBytes;
    if (remainingBytes <= 0) {
      throw new Error(
        `Agent source exceeds the ${WORK_AGENT_PACKAGE_MAX_SOURCE_BYTES.toLocaleString()} byte limit.`
      );
    }
    const payload = asRecord(
      await input.sandboxRequest({
        type: "download_file",
        sandboxId: input.sandboxId,
        payload: {
          path: `${input.root}/${filePath}`,
          maxBytes: remainingBytes,
        },
      })
    );
    const file = asRecord(payload.file);
    if (file.truncated === true) {
      throw new Error(`Agent source file is too large: ${filePath}.`);
    }
    const contentsBase64 = stringValue(file.contentsBase64);
    if (!contentsBase64) {
      throw new Error(`Agent source download was empty: ${filePath}.`);
    }
    let bytes: Buffer = Buffer.from(contentsBase64, "base64");
    const reportedSize =
      numberValue(file.totalSizeBytes) ?? numberValue(file.sizeBytes);
    if (reportedSize !== null && reportedSize !== bytes.byteLength) {
      throw new Error(`Agent source download was incomplete: ${filePath}.`);
    }
    if (filePath === "package.json") {
      bytes = normalizeAgentPackageJson(bytes);
    }
    totalSizeBytes += bytes.byteLength;
    if (totalSizeBytes > WORK_AGENT_PACKAGE_MAX_SOURCE_BYTES) {
      throw new Error(
        `Agent source exceeds the ${WORK_AGENT_PACKAGE_MAX_SOURCE_BYTES.toLocaleString()} byte limit.`
      );
    }
    files.push({
      path: filePath,
      sizeBytes: bytes.byteLength,
      sha256: sha256(bytes),
      contentsBase64: bytes.toString("base64"),
    });
  }
  return files;
}

function packageReceipts(
  files: Map<string, AgentPackage["source"]["files"][number]>,
  evalResults: Record<string, unknown>
): AgentPackageReceipt[] {
  const validator = requiredFile(files, ".openpond/validator-report.md");
  const evals = requiredFile(files, ".openpond/eval-results.json");
  const evalSummary = asRecord(evalResults.summary);
  const passed = numberValue(evalSummary.passed) ?? 0;
  const total = numberValue(evalSummary.total) ?? passed;
  return [
    {
      id: `validation-${validator.sha256.slice(0, 20)}`,
      kind: "sdk_validation",
      status: "passed",
      summary: "OpenPond Agent SDK validation completed successfully.",
      artifactPath: validator.path,
      artifactSha256: validator.sha256,
    },
    {
      id: `eval-${evals.sha256.slice(0, 20)}`,
      kind: "sdk_eval",
      status: "passed",
      summary: `${passed} of ${total} Agent SDK evals passed.`,
      artifactPath: evals.path,
      artifactSha256: evals.sha256,
    },
  ];
}

function agentPackageActions(
  value: unknown,
  manifest: Record<string, unknown>
): AgentPackageAction[] {
  if (!Array.isArray(value)) return [];
  const inputSchemas = asRecord(manifest.inputSchemas);
  const outputSchemas = asRecord(manifest.outputSchemas);
  return value.flatMap((item) => {
    const action = asRecord(item);
    const id = stringValue(action.id);
    if (!id) return [];
    return [
      {
        id,
        label: stringValue(action.label) || stringValue(action.name) || null,
        description: stringValue(action.description) || null,
        inputSchema: resolvedActionSchema(action.inputSchema, inputSchemas),
        outputSchema: resolvedActionSchema(action.outputSchema, outputSchemas),
        schedulePolicy: nullableRecord(action.schedulePolicy),
      },
    ];
  });
}

function resolvedActionSchema(
  value: unknown,
  namedSchemas: Record<string, unknown>
): Record<string, unknown> | null {
  const direct = nullableRecord(value);
  if (direct) return direct;
  const name = stringValue(value);
  return name ? nullableRecord(namedSchemas[name]) : null;
}

function jsonObjectFile(
  files: Map<string, AgentPackage["source"]["files"][number]>,
  filePath: string
): Record<string, unknown> {
  const file = requiredFile(files, filePath);
  try {
    return asRecord(
      JSON.parse(Buffer.from(file.contentsBase64, "base64").toString("utf8"))
    );
  } catch {
    throw new Error(`Agent SDK artifact is not valid JSON: ${filePath}.`);
  }
}

function requiredFile(
  files: Map<string, AgentPackage["source"]["files"][number]>,
  filePath: string
) {
  const file = files.get(filePath);
  if (!file) throw new Error(`Agent source is missing ${filePath}.`);
  return file;
}

function normalizeAgentPackageJson(bytes: Buffer): Buffer {
  try {
    const value = asRecord(JSON.parse(bytes.toString("utf8")));
    const dependencies = asRecord(value.dependencies);
    if ("openpond-agent-sdk" in dependencies) {
      dependencies["openpond-agent-sdk"] = "0.0.0";
      value.dependencies = dependencies;
    }
    return Buffer.from(`${stableStringify(value, 2)}\n`, "utf8");
  } catch {
    throw new Error("Agent package.json is not valid JSON.");
  }
}

function normalizeAgentDirectory(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/");
  const clean = path.posix.normalize(normalized);
  if (
    !clean ||
    clean === "." ||
    clean === ".." ||
    clean.startsWith("/") ||
    clean.startsWith("../") ||
    clean.split("/").some((part) => part === "..") ||
    !/^[a-zA-Z0-9._/-]+$/.test(clean)
  ) {
    throw new Error("Agent directory must stay inside Work scratch space.");
  }
  return clean;
}

function relativeAgentFilePath(value: unknown, root: string): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replaceAll("\\", "/");
  const workspaceRelative = normalized.startsWith("/workspace/")
    ? normalized.slice("/workspace/".length)
    : normalized.replace(/^\/+/, "");
  const clean = path.posix.normalize(workspaceRelative);
  if (clean === root) return null;
  if (!clean.startsWith(`${root}/`)) {
    throw new Error("Sandbox returned a file outside the Agent source root.");
  }
  const relative = clean.slice(root.length + 1);
  if (
    !relative ||
    relative === "." ||
    relative === ".." ||
    relative.startsWith("../")
  ) {
    throw new Error("Sandbox returned an invalid Agent source path.");
  }
  return relative;
}

function excludedAgentFile(filePath: string): boolean {
  return (
    filePath === ".DS_Store" ||
    filePath.startsWith("node_modules/") ||
    filePath.startsWith(".git/") ||
    filePath.startsWith(".openpond/traces/") ||
    filePath.startsWith(".openpond/local-scheduler/")
  );
}

function requireWorkSandbox(session: Session): string {
  if (session.experience !== "work") {
    throw new Error("Only Work tasks can prepare or save Agent packages.");
  }
  if (session.workspaceKind !== "sandbox" || !session.workspaceId) {
    throw new Error(
      "A running Work sandbox is required to prepare or save an Agent package."
    );
  }
  return session.workspaceId;
}

function assertSandboxCommandPassed(value: unknown, label: string): void {
  const payload = asRecord(value);
  const command = asRecord(payload.command);
  const exitCode = numberValue(command.exitCode);
  const status = stringValue(command.status);
  const output = stringValue(command.output);
  if (
    !["completed", "succeeded"].includes(status) ||
    (exitCode !== null && exitCode !== 0) ||
    ["failed", "error", "timed_out", "cancelled"].includes(status)
  ) {
    const detail = output || stringValue(command.stderr) || `${label} failed.`;
    throw new Error(`${label} failed: ${detail}`);
  }
}

async function writeImmutablePackage(
  destination: string,
  bytes: Buffer
): Promise<void> {
  const existing = await fs.readFile(destination).catch(() => null);
  if (existing) {
    if (!existing.equals(bytes)) {
      throw new Error(
        "Content-addressed Agent package storage contains a digest mismatch."
      );
    }
    return;
  }
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
  try {
    await fs.rename(temporary, destination);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    const winner = await fs.readFile(destination).catch(() => null);
    if (!winner?.equals(bytes)) throw error;
  }
}

async function nextPackageOutputIdentity(input: {
  runtimeEventsForSession: (sessionId: string) => Promise<RuntimeEvent[]>;
  sessionId: string;
  title: string;
}): Promise<{ id: string; revision: number }> {
  const events = await input.runtimeEventsForSession(input.sessionId);
  let latest: AgentPackageOutputRef | null = null;
  for (const event of events) {
    const output = findAgentPackageOutput(event.data);
    if (!output || output.title !== input.title) continue;
    if (!latest || output.revision > latest.revision) latest = output;
  }
  return {
    id: latest?.id ?? randomUUID(),
    revision: (latest?.revision ?? 0) + 1,
  };
}

function findAgentPackageOutput(
  value: unknown,
  depth = 0
): AgentPackageOutputRef | null {
  if (depth > 8 || value == null) return null;
  const parsed = AgentPackageOutputRefSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findAgentPackageOutput(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const child of Object.values(asRecord(value))) {
    const found = findAgentPackageOutput(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function findAgentPackageOutputById(
  value: unknown,
  outputId: string,
  revision?: number | null,
  depth = 0
): AgentPackageOutputRef | null {
  if (depth > 8 || value == null) return null;
  const parsed = AgentPackageOutputRefSchema.safeParse(value);
  if (
    parsed.success &&
    parsed.data.id === outputId &&
    (revision == null || parsed.data.revision === revision)
  ) {
    return parsed.data;
  }
  const children = Array.isArray(value)
    ? value
    : Object.values(asRecord(value));
  let latest: AgentPackageOutputRef | null = null;
  for (const child of children) {
    const found = findAgentPackageOutputById(
      child,
      outputId,
      revision,
      depth + 1
    );
    if (found && (!latest || found.revision > latest.revision)) latest = found;
  }
  return latest;
}

function safeTitle(value: string): string {
  const title = value.trim().replace(/\s+/g, " ").slice(0, 240);
  if (!title) throw new Error("Agent package title is required.");
  return title;
}

function safeAgentId(value: string): string {
  const id = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 191);
  if (!id) throw new Error("Agent package ID is required.");
  return id;
}

function stableStringify(value: unknown, space?: number): string {
  return JSON.stringify(sortJson(value), null, space);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)])
  );
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function nullableRecord(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  return Object.keys(record).length > 0 ? record : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
