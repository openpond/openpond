import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  FileOutputRefSchema,
  WorkOutputsResponseSchema,
  WORK_OUTPUT_CONTENT_TYPES,
  WORK_OUTPUT_MAX_BYTES,
  workFormatCapabilityForContentType,
  type FileOutputRef,
  type OutputValidationEvidence,
  type RuntimeEvent,
  type Session,
} from "@openpond/contracts";
import { sandboxRequestPayload } from "../openpond/sandboxes.js";

export type SaveWorkOutputInput = {
  session: Session;
  sourceTurnId: string;
  sandboxPath: string;
  suggestedName?: string | null;
  validation?: OutputValidationEvidence[];
  validationPolicy?: "strict" | "preserve";
};

export type SaveWorkOutputResult = {
  outputRef: FileOutputRef;
  artifact: {
    artifactRef: string;
    path: string;
    title: string;
    contentType: string;
    sizeBytes: number;
  };
};

export function createWorkOutputService(input: {
  deviceId: string;
  storeDir: string;
  runtimeEventsForSession: (sessionId: string) => Promise<RuntimeEvent[]>;
  sandboxRequest?: typeof sandboxRequestPayload;
}) {
  const outputRoot = path.join(input.storeDir, "work", "outputs");
  const sandboxRequest = input.sandboxRequest ?? sandboxRequestPayload;

  async function saveWorkOutput(
    request: SaveWorkOutputInput
  ): Promise<SaveWorkOutputResult> {
    if (request.session.experience !== "work") {
      throw new Error("Only Work tasks can save Work outputs.");
    }
    if (
      request.session.workspaceKind !== "sandbox" ||
      !request.session.workspaceId
    ) {
      throw new Error("A running Work sandbox is required to save an output.");
    }
    const sandboxPath = normalizeOutputCandidatePath(request.sandboxPath);
    const title = safeOutputName(
      request.suggestedName || path.posix.basename(sandboxPath)
    );
    const payload = asRecord(
      await sandboxRequest({
        type: "download_file",
        sandboxId: request.session.workspaceId,
        payload: {
          path: sandboxPath,
          maxBytes: WORK_OUTPUT_MAX_BYTES,
        },
      })
    );
    const file = asRecord(payload.file);
    if (file.truncated === true) {
      throw new Error(
        `Work output exceeds the ${WORK_OUTPUT_MAX_BYTES.toLocaleString()} byte limit.`
      );
    }
    const contentsBase64 =
      typeof file.contentsBase64 === "string" ? file.contentsBase64 : "";
    if (!contentsBase64) {
      throw new Error("Sandbox output download did not return file contents.");
    }
    const bytes = Buffer.from(contentsBase64, "base64");
    const reportedSize =
      numberValue(file.totalSizeBytes) ?? numberValue(file.sizeBytes);
    if (
      bytes.byteLength > WORK_OUTPUT_MAX_BYTES ||
      (reportedSize !== null && reportedSize > WORK_OUTPUT_MAX_BYTES)
    ) {
      throw new Error(
        `Work output exceeds the ${WORK_OUTPUT_MAX_BYTES.toLocaleString()} byte limit.`
      );
    }
    if (reportedSize !== null && bytes.byteLength !== reportedSize) {
      throw new Error("Sandbox output download was incomplete.");
    }

    const contentType =
      WORK_OUTPUT_CONTENT_TYPES[path.extname(title).toLowerCase()];
    if (!contentType) {
      throw new Error(
        `${title} is not an advertised Work output format. Save it as a supported file type or keep it in scratch space.`
      );
    }
    const validation = validateWorkOutput({
      bytes,
      contentType,
      title,
      supplied: request.validation ?? [],
      policy: request.validationPolicy ?? "strict",
    });
    const identity = await nextOutputIdentity({
      runtimeEventsForSession: input.runtimeEventsForSession,
      sessionId: request.session.id,
      title,
    });
    const outputId = identity.id;
    const revision = identity.revision;
    const taskDirectory = path.join(
      outputRoot,
      safePathSegment(request.session.id)
    );
    await fs.mkdir(taskDirectory, { recursive: true, mode: 0o700 });
    const destination = path.join(
      taskDirectory,
      `${String(revision).padStart(3, "0")}-${safePathSegment(
        outputId
      )}-${title}`
    );
    const temporary = path.join(
      taskDirectory,
      `.${path.basename(destination)}.${randomUUID()}.tmp`
    );
    await fs.writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
    try {
      await fs.rename(temporary, destination);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }

    const outputRef = FileOutputRefSchema.parse({
      kind: "file",
      id: outputId,
      title,
      contentType,
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sourceTaskId: request.session.id,
      sourceTurnId: request.sourceTurnId,
      revision,
      createdAt: new Date().toISOString(),
      location: {
        kind: "local",
        path: destination,
        deviceId: input.deviceId,
      },
      validation,
    });
    return {
      outputRef,
      artifact: {
        artifactRef: destination,
        path: destination,
        title,
        contentType,
        sizeBytes: bytes.byteLength,
      },
    };
  }

  async function saveAllWorkOutputs(request: {
    session: Session;
    sourceTurnId: string;
  }): Promise<SaveWorkOutputResult[]> {
    if (
      request.session.experience !== "work" ||
      request.session.workspaceKind !== "sandbox" ||
      !request.session.workspaceId
    ) {
      return [];
    }
    const listed = asRecord(
      await sandboxRequest({
        type: "list_files",
        sandboxId: request.session.workspaceId,
        payload: {
          path: "outputs",
          recursive: true,
          maxEntries: 500,
        },
      })
    );
    const files = Array.isArray(listed.files) ? listed.files : [];
    const events = await input.runtimeEventsForSession(request.session.id);
    const alreadySaved = new Set(
      fileOutputRefs(events)
        .filter((output) => output.sourceTurnId === request.sourceTurnId)
        .map((output) => output.title)
    );
    const saved: SaveWorkOutputResult[] = [];
    for (const value of files) {
      const file = asRecord(value);
      if (file.type !== "file" || typeof file.path !== "string") continue;
      const sandboxPath = file.path.replace(/^\/workspace\//, "");
      const title = safeOutputName(path.posix.basename(sandboxPath));
      if (alreadySaved.has(title)) continue;
      saved.push(
        await saveWorkOutput({
          session: request.session,
          sourceTurnId: request.sourceTurnId,
          sandboxPath,
          suggestedName: title,
          validationPolicy: "preserve",
        })
      );
      alreadySaved.add(title);
    }
    return saved;
  }

  async function workInputsForSession(session: Session): Promise<
    Array<{
      localPath: string;
      storageName: string;
      sha256: string;
      sizeBytes: number;
    }>
  > {
    if (session.experience !== "work") return [];
    const events = await input.runtimeEventsForSession(session.id);
    const latestByTitle = new Map<string, FileOutputRef>();
    for (const output of fileOutputRefs(events)) {
      if (output.location.kind !== "local") continue;
      const current = latestByTitle.get(output.title);
      if (!current || output.revision > current.revision) {
        latestByTitle.set(output.title, output);
      }
    }
    return [...latestByTitle.values()].map((output) => ({
      localPath: output.location.kind === "local" ? output.location.path : "",
      storageName: `${safePathSegment(output.id)}-${safeOutputName(output.title)}`,
      sha256: output.sha256,
      sizeBytes: output.sizeBytes,
    }));
  }

  async function listWorkOutputs(
    sessions: Session[]
  ): Promise<{ outputs: FileOutputRef[] }> {
    const outputGroups = await Promise.all(
      sessions
        .filter((session) => session.experience === "work")
        .map(async (session) =>
          activeFileOutputRefs(
            await input.runtimeEventsForSession(session.id)
          )
        )
    );
    return WorkOutputsResponseSchema.parse({
      outputs: outputGroups
        .flat()
        .sort((left, right) =>
          right.createdAt.localeCompare(left.createdAt)
        ),
    });
  }

  async function resolveLocalOutput(request: {
    session: Session;
    outputId: string;
    revision?: number | null;
  }): Promise<{ outputRef: FileOutputRef; target: string }> {
    if (request.session.experience !== "work") {
      throw new Error("Only Work tasks can access Work outputs.");
    }
    const outputId = request.outputId.trim();
    if (!outputId) throw new Error("A Work output id is required.");
    const events = await input.runtimeEventsForSession(request.session.id);
    const outputRef = findOutputRefById(events, outputId, request.revision);
    if (!outputRef) throw new Error("Work output not found.");
    if (outputRef.location.kind !== "local") {
      throw new Error("This Work output is not stored on this device.");
    }
    const taskDirectory = path.resolve(
      outputRoot,
      safePathSegment(request.session.id)
    );
    const target = path.resolve(outputRef.location.path);
    if (
      target === taskDirectory ||
      !target.startsWith(`${taskDirectory}${path.sep}`)
    ) {
      throw new Error("Work output path is outside managed local storage.");
    }
    return { outputRef, target };
  }

  async function deleteWorkOutput(request: {
    session: Session;
    outputId: string;
    revision?: number | null;
  }): Promise<{ outputRef: FileOutputRef; deleted: boolean }> {
    const { outputRef, target } = await resolveLocalOutput(request);
    const deleted = await fs
      .rm(target)
      .then(() => true)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
    return { outputRef, deleted };
  }

  async function readWorkOutput(request: {
    session: Session;
    outputId: string;
    revision?: number | null;
  }): Promise<{
    outputRef: FileOutputRef;
    contentsBase64: string;
  }> {
    const { outputRef, target } = await resolveLocalOutput(request);
    const bytes = await fs.readFile(target);
    if (bytes.byteLength > WORK_OUTPUT_MAX_BYTES) {
      throw new Error(
        `Work output exceeds the ${WORK_OUTPUT_MAX_BYTES.toLocaleString()} byte limit.`
      );
    }
    const checksum = createHash("sha256").update(bytes).digest("hex");
    if (
      bytes.byteLength !== outputRef.sizeBytes ||
      checksum !== outputRef.sha256
    ) {
      throw new Error("The saved Work output no longer matches its OutputRef.");
    }
    return {
      outputRef,
      contentsBase64: bytes.toString("base64"),
    };
  }

  return {
    outputRoot,
    deleteWorkOutput,
    listWorkOutputs,
    readWorkOutput,
    saveAllWorkOutputs,
    saveWorkOutput,
    workInputsForSession,
  };
}

function activeFileOutputRefs(events: RuntimeEvent[]): FileOutputRef[] {
  const outputs = new Map<string, FileOutputRef>();
  const deleted = new Set<string>();
  for (const event of events) {
    const refs = fileOutputRefs(event.data);
    if (event.action === "work_output_delete" && event.status === "completed") {
      for (const output of refs) {
        const key = fileOutputRevisionKey(output);
        deleted.add(key);
        outputs.delete(key);
      }
      continue;
    }
    if (event.action === "work_output_read") continue;
    for (const output of refs) {
      const key = fileOutputRevisionKey(output);
      if (!deleted.has(key)) outputs.set(key, output);
    }
  }
  return [...outputs.values()];
}

function fileOutputRevisionKey(output: FileOutputRef): string {
  return `${output.sourceTaskId}:${output.id}:${output.revision}`;
}

function validateWorkOutput(input: {
  bytes: Buffer;
  contentType: string;
  title: string;
  supplied: OutputValidationEvidence[];
  policy: "strict" | "preserve";
}): OutputValidationEvidence[] {
  const capability = workFormatCapabilityForContentType(input.contentType);
  if (!capability) return input.supplied;
  const structural = structuralValidation(input);
  if (structural.status !== "passed") {
    throw new Error(
      `Work output failed structural validation: ${structural.detail}`
    );
  }
  const evidence = [structural, ...input.supplied];
  const requiredEvidenceKinds = capability.validation.flatMap((mode) => {
    if (mode === "visual") return ["visual"] as const;
    if (mode === "playback" || mode === "browser") return ["test"] as const;
    return [];
  });
  for (const kind of requiredEvidenceKinds) {
    if (
      !evidence.some((item) => item.kind === kind && item.status === "passed")
    ) {
      if (input.policy === "strict") {
        throw new Error(
          `${input.title} requires passed ${kind} validation evidence before it can be saved as a completed Work output.`
        );
      }
      evidence.push({
        kind,
        status: "not_run",
        label: `${input.title} ${kind} validation was not run before automatic preservation`,
        detail:
          "The file was preserved automatically at turn completion; review this revision before relying on presentation or playback quality.",
      });
    }
  }
  return evidence;
}

function fileOutputRefs(value: unknown, depth = 0): FileOutputRef[] {
  if (depth > 8 || value == null) return [];
  const parsed = FileOutputRefSchema.safeParse(value);
  if (parsed.success) return [parsed.data];
  if (Array.isArray(value)) {
    return value.flatMap((item) => fileOutputRefs(item, depth + 1));
  }
  const record = asRecord(value);
  return Object.values(record).flatMap((child) =>
    fileOutputRefs(child, depth + 1)
  );
}

function structuralValidation(input: {
  bytes: Buffer;
  contentType: string;
  title: string;
}): OutputValidationEvidence {
  const passed = structuralContentMatches(input.bytes, input.contentType);
  return {
    kind: "structural",
    status: passed ? "passed" : "failed",
    label: `Validated ${input.title} structure`,
    detail: passed
      ? `Content matches ${input.contentType}.`
      : `Content does not match ${input.contentType}.`,
  };
}

function structuralContentMatches(bytes: Buffer, contentType: string): boolean {
  if (bytes.byteLength === 0) return false;
  if (
    contentType.startsWith("text/") ||
    contentType === "application/json" ||
    contentType === "image/svg+xml"
  ) {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return false;
    }
    if (contentType === "application/json") {
      try {
        JSON.parse(text);
      } catch {
        return false;
      }
    }
    if (contentType === "text/html") {
      return /<(?:!doctype\s+html|html|body)\b/i.test(text);
    }
    if (contentType === "image/svg+xml") return /<svg\b/i.test(text);
    return text.trim().length > 0;
  }
  if (contentType === "application/pdf") {
    return (
      bytes.subarray(0, 5).toString("ascii") === "%PDF-" &&
      bytes
        .subarray(Math.max(0, bytes.byteLength - 1_024))
        .toString("ascii")
        .includes("%%EOF")
    );
  }
  if (
    contentType.includes("wordprocessingml") ||
    contentType.includes("spreadsheetml") ||
    contentType.includes("presentationml")
  ) {
    const entries = zipCentralDirectoryEntries(bytes);
    const requiredEntry = contentType.includes("wordprocessingml")
      ? "word/document.xml"
      : contentType.includes("spreadsheetml")
      ? "xl/workbook.xml"
      : "ppt/presentation.xml";
    return (
      entries.has("[Content_Types].xml") &&
      entries.has("_rels/.rels") &&
      entries.has(requiredEntry)
    );
  }
  if (contentType === "image/png") {
    return bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (contentType === "image/jpeg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8;
  }
  if (contentType === "image/gif") {
    return bytes.subarray(0, 4).toString("ascii") === "GIF8";
  }
  if (contentType === "image/webp") {
    return (
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP"
    );
  }
  if (contentType === "image/avif") {
    return bytes.subarray(4, 12).toString("ascii").includes("ftyp");
  }
  if (contentType === "audio/wav") {
    return (
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WAVE"
    );
  }
  if (contentType === "audio/mpeg") {
    return (
      bytes.subarray(0, 3).toString("ascii") === "ID3" ||
      (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)
    );
  }
  if (
    contentType === "audio/mp4" ||
    contentType === "video/mp4" ||
    contentType === "video/quicktime"
  ) {
    return bytes.subarray(4, 12).toString("ascii").includes("ftyp");
  }
  if (contentType === "video/webm") {
    return bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  }
  return true;
}

function zipCentralDirectoryEntries(bytes: Buffer): Set<string> {
  const entries = new Set<string>();
  // Reading only the central-directory names is enough to reject renamed or
  // truncated files without inflating untrusted archive content on the host.
  for (let offset = 0; offset + 46 <= bytes.byteLength; ) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) {
      offset += 1;
      continue;
    }
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const entryEnd = offset + 46 + nameLength + extraLength + commentLength;
    if (entryEnd > bytes.byteLength) return new Set();
    const name = bytes
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString("utf8")
      .replaceAll("\\", "/")
      .replace(/^\/+/, "");
    if (name) entries.add(name);
    offset = entryEnd;
  }
  return entries;
}

export function normalizeOutputCandidatePath(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/")) {
    throw new Error("Work output path must be relative to /workspace.");
  }
  const clean = path.posix.normalize(normalized);
  if (
    clean === "." ||
    clean === ".." ||
    clean.startsWith("../") ||
    !clean.startsWith("outputs/") ||
    clean === "outputs/"
  ) {
    throw new Error(
      "Completed Work outputs must be inside /workspace/outputs."
    );
  }
  return clean;
}

async function nextOutputIdentity(input: {
  runtimeEventsForSession: (sessionId: string) => Promise<RuntimeEvent[]>;
  sessionId: string;
  title: string;
}): Promise<{ id: string; revision: number }> {
  const events = await input.runtimeEventsForSession(input.sessionId);
  let latest: FileOutputRef | null = null;
  for (const event of events) {
    const outputRef = findOutputRef(event.data);
    if (outputRef?.kind !== "file" || outputRef.title !== input.title) continue;
    if (!latest || outputRef.revision > latest.revision) latest = outputRef;
  }
  return {
    id: latest?.id ?? randomUUID(),
    revision: (latest?.revision ?? 0) + 1,
  };
}

function findOutputRef(value: unknown, depth = 0): FileOutputRef | null {
  if (depth > 6 || value == null) return null;
  const parsed = FileOutputRefSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (Array.isArray(value)) {
    for (const item of value) {
      const outputRef = findOutputRef(item, depth + 1);
      if (outputRef) return outputRef;
    }
    return null;
  }
  const record = asRecord(value);
  for (const child of Object.values(record)) {
    const outputRef = findOutputRef(child, depth + 1);
    if (outputRef) return outputRef;
  }
  return null;
}

function findOutputRefById(
  value: unknown,
  outputId: string,
  revision?: number | null,
  depth = 0
): FileOutputRef | null {
  if (depth > 8 || value == null) return null;
  const parsed = FileOutputRefSchema.safeParse(value);
  if (
    parsed.success &&
    parsed.data.id === outputId &&
    (revision == null || parsed.data.revision === revision)
  ) {
    return parsed.data;
  }
  if (Array.isArray(value)) {
    let latest: FileOutputRef | null = null;
    for (const item of value) {
      const outputRef = findOutputRefById(item, outputId, revision, depth + 1);
      if (outputRef && (!latest || outputRef.revision > latest.revision)) {
        latest = outputRef;
      }
    }
    return latest;
  }
  const record = asRecord(value);
  let latest: FileOutputRef | null = null;
  for (const child of Object.values(record)) {
    const outputRef = findOutputRefById(child, outputId, revision, depth + 1);
    if (outputRef && (!latest || outputRef.revision > latest.revision)) {
      latest = outputRef;
    }
  }
  return latest;
}

function safeOutputName(value: string): string {
  const base = path.basename(value.trim()).replace(/[^a-zA-Z0-9._ -]+/g, "-");
  const normalized = base.replace(/\s+/g, " ").trim().slice(0, 180);
  if (!normalized || normalized === "." || normalized === "..") {
    throw new Error("A valid output file name is required.");
  }
  return normalized;
}

function safePathSegment(value: string): string {
  return (
    value
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 100) || "item"
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
