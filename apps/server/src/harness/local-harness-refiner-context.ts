import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import {
  HarnessSourceManifestSchema,
  ImprovementObservationSchema,
  type ImprovementObservation,
  type RefinementTriggerDecision,
  type RuntimeEvent,
} from "@openpond/contracts";
import { contentHash } from "@openpond/harness";

import type { SqliteStore } from "../store/store.js";
import { executableSearchPath } from "../runtime/executable-search-path-bun-compat.js";

const MAX_REFINER_SOURCE_BYTES = 60_000;
const MAX_PDF_ARTIFACTS = 10;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const execFileAsync = promisify(execFile);

export async function loadBoundedRefinerContext(
  store: SqliteStore,
  trigger: RefinementTriggerDecision,
  observations: ImprovementObservation[],
): Promise<{
  task: {
    prompt: string | null;
    assistantOutput: string | null;
    assistantOutputLinkCount: number;
    previousAssistantOutput: string | null;
  };
  eventExcerpts: Array<Record<string, unknown>>;
  artifactDiagnostics: Array<Record<string, unknown>>;
}> {
  const [session, turn, events, turns] = await Promise.all([
    store.getSession(trigger.runRef),
    store.getTurn(trigger.turnId),
    store.runtimeEventsForSession(trigger.runRef, { limit: 1_000 }),
    store.turnsForSession(trigger.runRef, 1_000),
  ]);
  const orderedTurns = [...turns].sort((left, right) =>
    left.startedAt.localeCompare(right.startedAt),
  );
  const turnIndex = orderedTurns.findIndex((candidate) => candidate.id === trigger.turnId);
  const previousTurn = turnIndex > 0 ? orderedTurns[turnIndex - 1] : null;
  const eventRefs = new Map(
    observations.flatMap((observation) =>
      observation.eventRefs.map((reference) => [reference.id, reference] as const),
    ),
  );
  const exactEvents = events.filter((runtimeEvent) => eventRefs.has(runtimeEvent.id));
  for (const [eventId, reference] of eventRefs) {
    const runtimeEvent = exactEvents.find((candidate) => candidate.id === eventId);
    if (!runtimeEvent || contentHash(runtimeEvent) !== reference.contentHash) {
      throw new Error(`Refiner runtime event ${eventId} is unavailable or hash-mismatched.`);
    }
  }
  const evidenceEvents = selectRefinerEvidenceWindow({
    events,
    exactEvents,
    turnId: trigger.turnId,
    boundarySequence: trigger.boundary.eventSequence,
    limit: trigger.policy.maxEvidenceEvents,
  });
  const assistantOutput = assistantOutputForTurn(events, trigger.turnId);
  return {
    task: {
      prompt: turn?.prompt
        ? redactAndBoundRefinerText(turn.prompt, 8_000)
        : null,
      assistantOutput,
      assistantOutputLinkCount: countAbsoluteLinks(assistantOutput),
      previousAssistantOutput: previousTurn
        ? assistantOutputForTurn(events, previousTurn.id)
        : null,
    },
    artifactDiagnostics: await inspectBoundedPdfArtifactDiagnostics(session?.cwd),
    eventExcerpts: evidenceEvents.map((runtimeEvent) => {
      const data = asRecord(runtimeEvent.data);
      const result = asRecord(data.result);
      return {
        id: runtimeEvent.id,
        name: runtimeEvent.name,
        action: runtimeEvent.action ??
          (typeof data.tool === "string" ? data.tool : null),
        status: runtimeEvent.status ?? null,
        command: textField(result.command, 3_000),
        error: textField(runtimeEvent.error, 2_000),
        output: textField(result.output, 2_000) ?? textField(runtimeEvent.output, 2_000),
        exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
        timedOut: result.timedOut === true,
        stderr: textField(result.stderr, 3_000),
        stdout: textField(result.stdout, 3_000),
      };
    }),
  };
}

export async function inspectBoundedPdfArtifactDiagnostics(
  cwd: string | null | undefined,
): Promise<Array<Record<string, unknown>>> {
  if (!cwd) return [];
  let entries;
  try {
    entries = await fs.readdir(cwd, { withFileTypes: true });
  } catch {
    return [];
  }
  const pdfs = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf"))
    .slice(0, MAX_PDF_ARTIFACTS);
  return Promise.all(
    pdfs.map(async (entry) => {
      const filename = path.join(cwd, entry.name);
      try {
        const metadata = await fs.stat(filename);
        if (metadata.size > MAX_PDF_BYTES) {
          return {
            path: entry.name,
            mediaType: "application/pdf",
            check: "pdf_text_bounds",
            status: "unavailable",
            reason: `artifact exceeds ${MAX_PDF_BYTES} byte inspection bound`,
          };
        }
        const { stdout } = await execFileAsync("pdftotext", ["-bbox", filename, "-"], {
          env: { ...process.env, PATH: executableSearchPath() },
          maxBuffer: 8 * 1024 * 1024,
          timeout: 15_000,
        });
        return pdfTextBoundsDiagnostic(entry.name, stdout);
      } catch (error) {
        return {
          path: entry.name,
          mediaType: "application/pdf",
          check: "pdf_text_bounds",
          status: "unavailable",
          reason: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
        };
      }
    }),
  );
}

export function pdfTextBoundsDiagnostic(
  artifactPath: string,
  bboxXml: string,
): Record<string, unknown> {
  const clipped: Array<Record<string, unknown>> = [];
  let pages = 0;
  for (const pageMatch of bboxXml.matchAll(
    /<page\s+width="([^"]+)"\s+height="([^"]+)"[^>]*>([\s\S]*?)<\/page>/g,
  )) {
    pages += 1;
    const width = Number(pageMatch[1]);
    const height = Number(pageMatch[2]);
    for (const wordMatch of pageMatch[3].matchAll(
      /<word\s+xMin="([^"]+)"\s+yMin="([^"]+)"\s+xMax="([^"]+)"\s+yMax="([^"]+)"[^>]*>([\s\S]*?)<\/word>/g,
    )) {
      const [xMin, yMin, xMax, yMax] = wordMatch.slice(1, 5).map(Number);
      if (xMin >= 0 && yMin >= 0 && xMax <= width && yMax <= height) continue;
      clipped.push({
        page: pages,
        text: decodeXmlText(wordMatch[5]).slice(0, 120),
        xMin,
        yMin,
        xMax,
        yMax,
        pageWidth: width,
        pageHeight: height,
      });
    }
  }
  return {
    path: artifactPath,
    mediaType: "application/pdf",
    check: "pdf_text_bounds",
    status: clipped.length > 0 ? "failed" : "passed",
    pages,
    clippedTextCount: clipped.length,
    examples: clipped.slice(0, 10),
  };
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

function countAbsoluteLinks(value: string | null): number {
  if (!value) return 0;
  return value.match(/https?:\/\/[^\s<>)\]}"']+/gi)?.length ?? 0;
}

function assistantOutputForTurn(
  events: readonly RuntimeEvent[],
  turnId: string,
): string | null {
  const output = events
    .filter((runtimeEvent) =>
      runtimeEvent.turnId === turnId &&
      runtimeEvent.name === "assistant.delta" &&
      typeof runtimeEvent.output === "string",
    )
    .sort(compareRuntimeEvents)
    .map((runtimeEvent) => runtimeEvent.output)
    .join("");
  return output ? redactAndBoundRefinerText(output, 8_000) : null;
}

export async function loadExactObservations(
  store: SqliteStore,
  workspaceId: string,
  trigger: RefinementTriggerDecision,
): Promise<ImprovementObservation[]> {
  const available = await store.listHarnessImprovementArtifacts(
    workspaceId,
    "observation",
    1_000,
  );
  const byHash = new Map(
    available.map((artifact) => {
      const observation = ImprovementObservationSchema.parse(artifact);
      return [observation.contentHash, observation] as const;
    }),
  );
  return trigger.observations.map((reference) => {
    const observation = byHash.get(reference.contentHash);
    if (!observation || observation.id !== reference.id) {
      throw new Error(`Refiner observation ${reference.id} is unavailable or hash-mismatched.`);
    }
    return observation;
  });
}

export async function readBoundedRefinerSource(
  bundlePath: string,
  trigger: RefinementTriggerDecision,
) {
  const loadedSkillNames = loadedSkillNamesFromTrigger(trigger);
  const sourceRoot = path.resolve(bundlePath, "source");
  const manifest = HarnessSourceManifestSchema.parse(
    JSON.parse(await fs.readFile(path.join(sourceRoot, "harness.json"), "utf8")),
  );
  let remaining = MAX_REFINER_SOURCE_BYTES;
  const result: Array<{
    path: string;
    kind: "memory" | "instruction" | "skill" | "agent";
    content: string;
    loaded: boolean;
  }> = [];
  const catalog: Array<{
    path: string;
    kind: "memory" | "instruction" | "skill" | "agent";
    loaded: boolean;
  }> = manifest.files
    .filter((file): file is typeof file & { kind: "instruction" | "skill" | "agent" } =>
      ["instruction", "skill", "agent"].includes(file.kind) && file.visibility === "policy",
    )
    .map((file) => ({
      path: file.path,
      kind: file.kind,
      loaded: file.kind === "skill" && loadedSkillNames.has(skillNameFromPath(file.path)),
    }));
  for (const file of manifest.files) {
    if (
      !["instruction", "skill", "agent"].includes(file.kind) ||
      file.visibility !== "policy" ||
      !["text/markdown", "text/plain", "text/javascript"].includes(file.mediaType)
    ) {
      continue;
    }
    const target = containedSourcePath(sourceRoot, file.path);
    const stats = await fs.lstat(target);
    if (!stats.isFile() || stats.isSymbolicLink()) continue;
    const bytes = await fs.readFile(target);
    if (bytes.byteLength > remaining) continue;
    result.push({
      path: file.path,
      kind: file.kind as "instruction" | "skill" | "agent",
      content: bytes.toString("utf8"),
      loaded: file.kind === "skill" && loadedSkillNames.has(skillNameFromPath(file.path)),
    });
    remaining -= bytes.byteLength;
  }
  return { manifest, files: result, catalog };
}

function selectRefinerEvidenceWindow(input: {
  events: readonly RuntimeEvent[];
  exactEvents: readonly RuntimeEvent[];
  turnId: string;
  boundarySequence: number;
  limit: number;
}): RuntimeEvent[] {
  const orderedExact = [...input.exactEvents].sort(compareRuntimeEvents);
  const firstEvidenceSequence = orderedExact.reduce<number | null>(
    (first, runtimeEvent) => {
      if (runtimeEvent.sequence === undefined) return first;
      return first === null
        ? runtimeEvent.sequence
        : Math.min(first, runtimeEvent.sequence);
    },
    null,
  );
  const candidates = input.events
    .filter((runtimeEvent) =>
      runtimeEvent.turnId === input.turnId &&
      isRefinerEvidenceEvent(runtimeEvent) &&
      (firstEvidenceSequence === null ||
        runtimeEvent.sequence === undefined ||
        runtimeEvent.sequence >= firstEvidenceSequence) &&
      (runtimeEvent.sequence === undefined || runtimeEvent.sequence <= input.boundarySequence),
    )
    .sort(compareRuntimeEvents);
  if (candidates.length <= input.limit) return candidates;
  const exactIds = new Set(orderedExact.map((runtimeEvent) => runtimeEvent.id));
  const retainedExact = orderedExact.slice(0, input.limit);
  const remaining = input.limit - retainedExact.length;
  if (remaining <= 0) return retainedExact;
  const tail = candidates
    .filter((runtimeEvent) => !exactIds.has(runtimeEvent.id))
    .slice(-remaining);
  return [...retainedExact, ...tail].sort(compareRuntimeEvents);
}

function isRefinerEvidenceEvent(runtimeEvent: RuntimeEvent): boolean {
  return [
    "tool.completed",
    "workspace_action_result",
    "skill.loaded",
    "validation.completed",
  ].includes(runtimeEvent.name);
}

function compareRuntimeEvents(left: RuntimeEvent, right: RuntimeEvent): number {
  return (left.sequence ?? Number.MAX_SAFE_INTEGER) -
    (right.sequence ?? Number.MAX_SAFE_INTEGER);
}

function textField(value: unknown, maxLength: number): string | null {
  return typeof value === "string" ? redactAndBoundRefinerText(value, maxLength) : null;
}

function redactAndBoundRefinerText(value: string, maxLength: number): string {
  const redacted = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(
      /\b(api[_-]?key|access[_-]?token|auth(?:orization)?|password|secret)(\s*[:=]\s*)([^\s,;]+)/gi,
      "$1$2[redacted]",
    );
  return redacted.length <= maxLength
    ? redacted
    : `${redacted.slice(0, maxLength)}\n[truncated]`;
}

function loadedSkillNamesFromTrigger(trigger: RefinementTriggerDecision): ReadonlySet<string> {
  const names = trigger.metadata.loadedSkillNames;
  if (!Array.isArray(names)) return new Set();
  return new Set(
    names.filter((name): name is string => typeof name === "string" && name.trim().length > 0),
  );
}

function skillNameFromPath(sourcePath: string): string {
  const match = /^skills\/([^/]+)\/SKILL\.md$/.exec(sourcePath.replaceAll("\\", "/"));
  return match?.[1] ?? "";
}

function containedSourcePath(root: string, relativePath: string): string {
  const target = path.resolve(root, ...relativePath.replaceAll("\\", "/").split("/"));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Harness source path escapes its immutable bundle: ${relativePath}`);
  }
  return target;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
