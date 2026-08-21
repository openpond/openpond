import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import {
  FileOutputRefSchema,
  HarnessSourceManifestSchema,
  ImprovementObservationSchema,
  type FileOutputRef,
  type ImprovementObservation,
  type RefinementTriggerDecision,
  type RuntimeEvent,
  type Turn,
} from "@openpond/contracts";
import { contentHash } from "@openpond/harness";

import type { SqliteStore } from "../store/store.js";
import { executableSearchPath } from "../runtime/executable-search-path-bun-compat.js";

const MAX_REFINER_SOURCE_BYTES = 36_000;
const MAX_PDF_ARTIFACTS = 10;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_REVIEW_TIMELINE_EVENTS = 40;
const MAX_REVIEW_TIMELINE_CHARS = 24_000;
const MAX_PRIOR_CONVERSATION_TURNS = 3;
const MAX_PRIOR_INCIDENTS = 3;
const MAX_PRIOR_INCIDENT_TIMELINE_EVENTS = 6;
const REFINER_CONTEXT_EVENT_NAMES = [
  "turn.started",
  "assistant.delta",
  "tool.started",
  "tool.completed",
  "skill.loaded",
  "workspace_action_result",
  "diagnostic",
  "turn.completed",
  "turn.failed",
  "turn.interrupted",
] as const;
const execFileAsync = promisify(execFile);

export async function loadBoundedRefinerContext(
  store: SqliteStore,
  trigger: RefinementTriggerDecision,
  observations: ImprovementObservation[],
  workspaceId?: string,
  options?: { allowMissingRuntimeEvents?: boolean },
): Promise<{
  task: {
    prompt: string | null;
    assistantOutput: string | null;
    assistantOutputLinkCount: number;
    previousAssistantOutput: string | null;
  };
  eventExcerpts: Array<Record<string, unknown>>;
  artifactDiagnostics: Array<Record<string, unknown>>;
  executionProfile: {
    modelRequestCount: number;
    failedModelRequestCount: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    toolFailureCount: number;
    retryCount: number;
    recoveryCount: number;
  };
  reviewPacket: {
    currentTurn: {
      id: string;
      status: string | null;
      error: string | null;
      prompt: string | null;
      assistantOutput: string | null;
      assistantOutputLinkCount: number;
    };
    priorConversation: Array<{
      turnId: string;
      status: string | null;
      prompt: string | null;
      assistantOutput: string | null;
    }>;
    timeline: Array<Record<string, unknown>>;
    artifacts: Array<Record<string, unknown>>;
    artifactDiagnostics: Array<Record<string, unknown>>;
    executionProfile: {
      modelRequestCount: number;
      failedModelRequestCount: number;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      toolFailureCount: number;
      retryCount: number;
      recoveryCount: number;
    };
    priorIncidents: Array<Record<string, unknown>>;
    truncation: {
      timelineEventCount: number;
      includedTimelineEventCount: number;
      timelineTruncated: boolean;
    };
  };
}> {
  const [session, turn, events, turns, usageRecords] = await Promise.all([
    store.getSession(trigger.runRef),
    store.getTurn(trigger.turnId),
    store.runtimeEventsForTurn(trigger.turnId, { names: REFINER_CONTEXT_EVENT_NAMES }),
    store.turnsForSession(trigger.runRef, 1_000),
    store.listModelUsageRecords({ turnId: trigger.turnId, limit: 10_000 }),
  ]);
  const orderedTurns = [...turns].sort((left, right) =>
    left.startedAt.localeCompare(right.startedAt),
  );
  const turnIndex = orderedTurns.findIndex((candidate) => candidate.id === trigger.turnId);
  const previousTurn = turnIndex > 0 ? orderedTurns[turnIndex - 1] : null;
  const priorConversationTurns = orderedTurns.slice(
    Math.max(0, turnIndex - MAX_PRIOR_CONVERSATION_TURNS),
    Math.max(0, turnIndex),
  );
  const priorConversationEvents = new Map(
    await Promise.all(
      priorConversationTurns.map(async (candidate) => [
        candidate.id,
        await store.runtimeEventsForTurn(candidate.id, { names: ["assistant.delta"] }),
      ] as const),
    ),
  );
  const eventRefs = new Map(
    observations.flatMap((observation) =>
      observation.eventRefs.map((reference) => [reference.id, reference] as const),
    ),
  );
  const exactEvents = events.filter((runtimeEvent) => eventRefs.has(runtimeEvent.id));
  if (!options?.allowMissingRuntimeEvents) {
    for (const [eventId, reference] of eventRefs) {
      const runtimeEvent = exactEvents.find((candidate) => candidate.id === eventId);
      if (!runtimeEvent || contentHash(runtimeEvent) !== reference.contentHash) {
        throw new Error(`Refiner runtime event ${eventId} is unavailable or hash-mismatched.`);
      }
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
  const observationKinds = observations.map((observation) => observation.kind);
  const receiptProfile = tasksetGradeExecutionProfile(events, trigger.turnId);
  const durableUsage = {
    modelRequestCount: usageRecords.length || receiptProfile.modelRequestCount,
    promptTokens: usageRecords.reduce(
      (total, record) => total + (record.promptTokens ?? 0),
      0,
    ) || receiptProfile.promptTokens,
    completionTokens: usageRecords.reduce(
      (total, record) => total + (record.completionTokens ?? 0),
      0,
    ) || receiptProfile.completionTokens,
    totalTokens: usageRecords.reduce(
      (total, record) => total + (record.totalTokens ?? 0),
      0,
    ) || receiptProfile.totalTokens,
  };
  const executionProfile = {
    modelRequestCount: durableUsage.modelRequestCount,
    failedModelRequestCount: usageRecords.filter(
      (record) => record.status === "failed" || record.status === "interrupted",
    ).length,
    promptTokens: durableUsage.promptTokens,
    completionTokens: durableUsage.completionTokens,
    totalTokens: durableUsage.totalTokens,
    toolFailureCount: observationKinds.filter((kind) => kind === "tool_failure").length,
    retryCount: observationKinds.filter((kind) => kind === "retry").length,
    recoveryCount: observationKinds.filter((kind) => kind === "recovery").length,
  };
  const artifactDiagnostics = await inspectBoundedPdfArtifactDiagnostics(session?.cwd);
  const timelineCandidates = events
    .filter((runtimeEvent) =>
      runtimeEvent.turnId === trigger.turnId
      && isRefinerReviewTimelineEvent(runtimeEvent)
      && (runtimeEvent.sequence === undefined || runtimeEvent.sequence <= trigger.boundary.eventSequence)
    )
    .sort(compareRuntimeEvents);
  const timeline = boundedReviewTimeline(timelineCandidates);
  const priorConversation = priorConversationTurns.map((candidate) =>
    conversationTurn(candidate, priorConversationEvents.get(candidate.id) ?? [])
  );
  const priorIncidents = workspaceId
    ? await loadRelevantPriorIncidentPackets({
        store,
        workspaceId,
        trigger,
        observations,
      })
    : [];
  return {
    task: {
      prompt: turn?.prompt
        ? redactAndBoundRefinerText(turn.prompt, 8_000)
        : null,
      assistantOutput,
      assistantOutputLinkCount: countAbsoluteLinks(assistantOutput),
      previousAssistantOutput: previousTurn
        ? assistantOutputForTurn(
            priorConversationEvents.get(previousTurn.id) ?? [],
            previousTurn.id,
          )
        : null,
    },
    artifactDiagnostics,
    executionProfile,
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
    reviewPacket: {
      currentTurn: {
        id: trigger.turnId,
        status: turn?.status ?? null,
        error: turn?.error ? redactAndBoundRefinerText(turn.error, 2_000) : null,
        prompt: turn?.prompt ? redactAndBoundRefinerText(turn.prompt, 8_000) : null,
        assistantOutput,
        assistantOutputLinkCount: countAbsoluteLinks(assistantOutput),
      },
      priorConversation,
      timeline,
      artifacts: fileOutputInventory(events, trigger.turnId),
      artifactDiagnostics,
      executionProfile,
      priorIncidents,
      truncation: {
        timelineEventCount: timelineCandidates.length,
        includedTimelineEventCount: timeline.length,
        timelineTruncated: timeline.length < timelineCandidates.length,
      },
    },
  };
}

function conversationTurn(
  turn: Turn,
  events: readonly RuntimeEvent[],
): {
  turnId: string;
  status: string | null;
  prompt: string | null;
  assistantOutput: string | null;
} {
  return {
    turnId: turn.id,
    status: turn.status,
    prompt: turn.prompt ? redactAndBoundRefinerText(turn.prompt, 3_000) : null,
    assistantOutput: assistantOutputForTurn(events, turn.id, 3_000),
  };
}

function boundedReviewTimeline(events: readonly RuntimeEvent[]): Array<Record<string, unknown>> {
  const mapped = events.map(reviewTimelineEntry);
  if (mapped.length <= MAX_REVIEW_TIMELINE_EVENTS) {
    return fitTimelineToCharacterBudget(mapped);
  }
  const important = mapped.filter((entry) =>
    entry.status === "failed"
    || entry.name === "turn.completed"
    || entry.name === "turn.failed"
    || entry.name === "turn.interrupted"
    || entry.name === "skill.loaded"
    || entry.name === "validation.completed"
    || entry.name === "diagnostic"
  );
  const retainedKeys = new Set(important.map(timelineEntryKey));
  const remaining = mapped
    .filter((entry) => !retainedKeys.has(timelineEntryKey(entry)))
    .slice(-(MAX_REVIEW_TIMELINE_EVENTS - Math.min(important.length, MAX_REVIEW_TIMELINE_EVENTS)));
  return fitTimelineToCharacterBudget(
    [...important.slice(-MAX_REVIEW_TIMELINE_EVENTS), ...remaining]
      .sort((left, right) => Number(left.sequence ?? 0) - Number(right.sequence ?? 0)),
  );
}

function fitTimelineToCharacterBudget(
  entries: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const retained: Array<Record<string, unknown>> = [];
  let used = 0;
  for (const entry of entries) {
    const size = JSON.stringify(entry).length;
    if (used + size > MAX_REVIEW_TIMELINE_CHARS) continue;
    retained.push(entry);
    used += size;
  }
  return retained;
}

function reviewTimelineEntry(runtimeEvent: RuntimeEvent): Record<string, unknown> {
  const data = asRecord(runtimeEvent.data);
  const result = asRecord(data.result);
  return {
    sequence: runtimeEvent.sequence ?? null,
    timestamp: runtimeEvent.timestamp,
    name: runtimeEvent.name,
    action: runtimeEvent.action ?? (typeof data.tool === "string" ? data.tool : null),
    status: runtimeEvent.status ?? null,
    args: boundedUnknown(runtimeEvent.args, 1_500),
    command: textField(result.command, 2_000),
    error: textField(runtimeEvent.error, 2_000),
    output: textField(result.output, 2_000) ?? textField(runtimeEvent.output, 2_000),
    exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
    timedOut: result.timedOut === true,
    stderr: textField(result.stderr, 2_000),
    stdout: textField(result.stdout, 2_000),
  };
}

function timelineEntryKey(entry: Record<string, unknown>): string {
  return `${entry.sequence ?? "none"}:${entry.name ?? "unknown"}:${entry.action ?? "none"}`;
}

function fileOutputInventory(
  events: readonly RuntimeEvent[],
  turnId: string,
): Array<Record<string, unknown>> {
  const byRevision = new Map<string, FileOutputRef>();
  for (const runtimeEvent of events) {
    if (runtimeEvent.turnId !== turnId) continue;
    for (const output of findFileOutputRefs(runtimeEvent.data)) {
      byRevision.set(`${output.id}:${output.revision}`, output);
    }
  }
  return [...byRevision.values()]
    .sort((left, right) => left.title.localeCompare(right.title) || left.revision - right.revision)
    .slice(0, 30)
    .map((output) => ({
      id: output.id,
      title: output.title,
      revision: output.revision,
      contentType: output.contentType,
      sizeBytes: output.sizeBytes,
      sha256: output.sha256,
      locationKind: output.location.kind,
      validation: output.validation.map((validation) => ({
        kind: validation.kind,
        status: validation.status,
        label: validation.label,
        detail: validation.detail ?? null,
      })),
    }));
}

function findFileOutputRefs(value: unknown, depth = 0): FileOutputRef[] {
  if (depth > 8) return [];
  const parsed = FileOutputRefSchema.safeParse(value);
  if (parsed.success) return [parsed.data];
  if (Array.isArray(value)) {
    return value.flatMap((item) => findFileOutputRefs(item, depth + 1));
  }
  if (!value || typeof value !== "object") return [];
  return Object.values(value as Record<string, unknown>).flatMap((item) =>
    findFileOutputRefs(item, depth + 1)
  );
}

async function loadRelevantPriorIncidentPackets(input: {
  store: SqliteStore;
  workspaceId: string;
  trigger: RefinementTriggerDecision;
  observations: ImprovementObservation[];
}): Promise<Array<Record<string, unknown>>> {
  const currentClasses = new Set(
    input.observations.flatMap((observation) =>
      observation.deterministicClass ? [observation.deterministicClass] : []
    ),
  );
  const currentTools = new Set(
    input.observations.flatMap((observation) => observation.tool ? [observation.tool.name] : []),
  );
  if (currentClasses.size === 0 && currentTools.size === 0) return [];
  const available = (await input.store.listHarnessImprovementArtifacts(
    input.workspaceId,
    "observation",
    200,
  ) as ImprovementObservation[])
    .filter((observation) =>
      observation.runRef !== input.trigger.runRef
      && observation.turnId !== input.trigger.turnId
      && (
        (observation.deterministicClass !== null && currentClasses.has(observation.deterministicClass))
        || (observation.tool !== null && currentTools.has(observation.tool.name))
      )
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const byTurn = new Map<string, ImprovementObservation[]>();
  for (const observation of available) {
    const key = `${observation.runRef}:${observation.turnId}`;
    const list = byTurn.get(key) ?? [];
    list.push(observation);
    byTurn.set(key, list);
  }
  const packets: Array<Record<string, unknown>> = [];
  for (const group of byTurn.values()) {
    if (packets.length >= MAX_PRIOR_INCIDENTS) break;
    const first = group[0]!;
    const [turn, events] = await Promise.all([
      input.store.getTurn(first.turnId),
      input.store.runtimeEventsForTurn(first.turnId, { names: REFINER_CONTEXT_EVENT_NAMES }),
    ]);
    if (!turn) continue;
    const matchingClasses = [...new Set(group.flatMap((observation) =>
      observation.deterministicClass && currentClasses.has(observation.deterministicClass)
        ? [observation.deterministicClass]
        : []
    ))];
    const matchingTools = [...new Set(group.flatMap((observation) =>
      observation.tool && currentTools.has(observation.tool.name)
        ? [observation.tool.name]
        : []
    ))];
    const timeline = priorIncidentTimeline(
      events.filter((runtimeEvent) => runtimeEvent.turnId === turn.id),
    );
    packets.push({
      runRef: first.runRef,
      turnId: first.turnId,
      createdAt: first.createdAt,
      matchedBy: {
        deterministicClasses: matchingClasses,
        tools: matchingTools,
      },
      observations: group.slice(0, 4).map((observation) => ({
        kind: observation.kind,
        state: observation.state,
        deterministicClass: observation.deterministicClass,
        summary: observation.summary,
      })),
      prompt: turn.prompt ? redactAndBoundRefinerText(turn.prompt, 1_200) : null,
      assistantOutput: assistantOutputForTurn(events, turn.id, 1_200),
      timeline,
      artifacts: fileOutputInventory(events, turn.id).slice(0, 5),
    });
  }
  return packets;
}

function priorIncidentTimeline(events: readonly RuntimeEvent[]): Array<Record<string, unknown>> {
  const terminalNames = new Set(["turn.completed", "turn.failed", "turn.interrupted"]);
  const candidates = events
    .filter((runtimeEvent) => {
      if (terminalNames.has(runtimeEvent.name)) return true;
      const serialized = JSON.stringify({
        error: runtimeEvent.error,
        output: runtimeEvent.output,
        data: runtimeEvent.data,
      });
      return runtimeEvent.status === "failed"
        || /"ok"\s*:\s*false|failed|denied|unavailable|timed?\s*out|exception|traceback/i.test(serialized);
    })
    .sort(compareRuntimeEvents)
    .map((runtimeEvent) => {
      const entry = reviewTimelineEntry(runtimeEvent);
      return {
        sequence: entry.sequence,
        name: entry.name,
        action: entry.action,
        status: entry.status,
        error: textField(entry.error, 800),
        output: textField(entry.output, 800),
        exitCode: entry.exitCode,
        timedOut: entry.timedOut,
      };
    });
  const unique = new Map<string, Record<string, unknown> & { occurrenceCount: number }>();
  for (const entry of candidates) {
    const signature = JSON.stringify({
      name: entry.name,
      action: entry.action,
      status: entry.status,
      error: entry.error,
      output: entry.output,
      exitCode: entry.exitCode,
      timedOut: entry.timedOut,
    });
    const existing = unique.get(signature);
    if (existing) {
      existing.occurrenceCount += 1;
      continue;
    }
    unique.set(signature, { ...entry, occurrenceCount: 1 });
  }
  const compact = [...unique.values()];
  if (compact.length <= MAX_PRIOR_INCIDENT_TIMELINE_EVENTS) return compact;
  return [
    ...compact.slice(0, MAX_PRIOR_INCIDENT_TIMELINE_EVENTS - 2),
    ...compact.slice(-2),
  ];
}

function boundedUnknown(value: unknown, maxLength: number): unknown {
  if (value === undefined) return null;
  try {
    const text = redactAndBoundRefinerText(JSON.stringify(value), maxLength);
    return JSON.parse(text.endsWith("\n[truncated]") ? JSON.stringify(text) : text);
  } catch {
    return redactAndBoundRefinerText(String(value), maxLength);
  }
}

export function tasksetGradeExecutionProfile(
  events: readonly RuntimeEvent[],
  turnId: string,
): {
  modelRequestCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
} {
  const fallback = {
    modelRequestCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
  const diagnostic = [...events].reverse().find((runtimeEvent) =>
    runtimeEvent.turnId === turnId
    && runtimeEvent.name === "diagnostic"
    && runtimeEvent.action === "taskset_grade"
    && typeof runtimeEvent.output === "string"
  );
  if (!diagnostic?.output) return fallback;
  try {
    const payload = asRecord(JSON.parse(diagnostic.output));
    const attempt = asRecord(payload.attempt);
    const usage = asRecord(attempt.usage);
    return {
      modelRequestCount: nonnegativeInteger(attempt.modelRequestCount),
      promptTokens: nonnegativeInteger(usage.promptTokens),
      completionTokens: nonnegativeInteger(usage.completionTokens),
      totalTokens: nonnegativeInteger(usage.totalTokens),
    };
  } catch {
    return fallback;
  }
}

function nonnegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0;
}

export async function inspectBoundedPdfArtifactDiagnostics(
  cwd: string | null | undefined,
): Promise<Array<Record<string, unknown>>> {
  if (!cwd) return [];
  const pdfs: Array<{ filename: string; displayPath: string }> = [];
  for (const root of [cwd, path.join(cwd, "outputs")]) {
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".pdf")) continue;
      pdfs.push({
        filename: path.join(root, entry.name),
        displayPath: path.relative(cwd, path.join(root, entry.name)).replaceAll(path.sep, "/"),
      });
      if (pdfs.length >= MAX_PDF_ARTIFACTS) break;
    }
    if (pdfs.length >= MAX_PDF_ARTIFACTS) break;
  }
  return Promise.all(
    pdfs.map(async ({ filename, displayPath }) => {
      try {
        const metadata = await fs.stat(filename);
        if (metadata.size > MAX_PDF_BYTES) {
          return {
            path: displayPath,
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
        return pdfTextBoundsDiagnostic(displayPath, stdout);
      } catch (error) {
        return {
          path: displayPath,
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
  maxLength = 8_000,
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
  return output ? redactAndBoundRefinerText(output, maxLength) : null;
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
  options: { forceUnloaded?: boolean } = {},
) {
  const loadedSkillNames = loadedSkillNamesFromTrigger(trigger);
  const sourceWasAdmitted = options.forceUnloaded !== true;
  const wasLoaded = (kind: "instruction" | "skill" | "agent", filePath: string) =>
    sourceWasAdmitted && (
      kind === "instruction" ||
      (kind === "skill" && loadedSkillNames.has(skillNameFromPath(filePath)))
    );
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
      loaded: wasLoaded(file.kind, file.path),
    }));
  const rankedFiles = manifest.files.slice().sort((left, right) => {
    const leftLoaded = ["instruction", "skill", "agent"].includes(left.kind)
      && wasLoaded(left.kind as "instruction" | "skill" | "agent", left.path);
    const rightLoaded = ["instruction", "skill", "agent"].includes(right.kind)
      && wasLoaded(right.kind as "instruction" | "skill" | "agent", right.path);
    if (leftLoaded !== rightLoaded) return leftLoaded ? -1 : 1;
    const rank = (kind: string) => kind === "instruction" ? 0 : kind === "skill" ? 1 : 2;
    return rank(left.kind) - rank(right.kind) || left.path.localeCompare(right.path);
  });
  for (const file of rankedFiles) {
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
      loaded: wasLoaded(file.kind as "instruction" | "skill" | "agent", file.path),
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
  const candidates = input.events
    .filter((runtimeEvent) =>
      runtimeEvent.turnId === input.turnId &&
      isRefinerEvidenceEvent(runtimeEvent) &&
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

export function isRefinerEvidenceEvent(runtimeEvent: RuntimeEvent): boolean {
  return [
    "tool.completed",
    "workspace_action_result",
    "skill.loaded",
    "validation.completed",
    "diagnostic",
  ].includes(runtimeEvent.name);
}

export function isRefinerReviewTimelineEvent(runtimeEvent: RuntimeEvent): boolean {
  return [
    "turn.completed",
    "turn.failed",
    "turn.interrupted",
    "tool.completed",
    "workspace_action_result",
    "skill.loaded",
    "validation.completed",
    "diagnostic",
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
