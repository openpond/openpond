import type {
  InsightsRunPromptEvidenceItem,
  InsightsRunPromptSummary,
} from "./app-models";
import { asRecord } from "./chat-message-utils";

type EvidenceParseResult = {
  afterSequence: number | null;
  eventCount: number | null;
  evidenceSources: string[];
  items: InsightsRunPromptEvidenceItem[];
  latestSequence: number | null;
  totalEvidenceCount: number | null;
  truncated: boolean;
};

export function insightsRunPromptSummaryFromTurnStarted(
  args: unknown,
  prompt: string,
): InsightsRunPromptSummary | null {
  const record = asRecord(args);
  const run = asRecord(record?.insightsRun);
  const preview = asRecord(record?.insightsEvidencePreview);
  const parsedEvidence = preview ? evidencePreviewFromRecord(preview) : evidenceFromPrompt(prompt);
  if (!run && !parsedEvidence && !isInsightsRunPrompt(prompt)) return null;

  const runSources = stringArray(run?.evidenceSources);
  const evidenceSources = runSources.length > 0 ? runSources : parsedEvidence?.evidenceSources ?? [];
  const totalEvidenceCount =
    numberValue(preview?.totalCount) ??
    parsedEvidence?.totalEvidenceCount ??
    parsedEvidence?.items.length ??
    0;
  return {
    runId: stringValue(run?.id),
    trigger: stringValue(run?.trigger),
    status: stringValue(run?.status),
    evidenceSources,
    eventCount: numberValue(preview?.eventCount) ?? parsedEvidence?.eventCount ?? null,
    afterSequence: numberValue(preview?.afterSequence) ?? parsedEvidence?.afterSequence ?? null,
    latestSequence: numberValue(preview?.latestSequence) ?? parsedEvidence?.latestSequence ?? null,
    findingCount: numberValue(run?.findingCount),
    promptLength: prompt.length,
    totalEvidenceCount,
    truncated: Boolean(preview?.truncated) || Boolean(parsedEvidence?.truncated),
    items: parsedEvidence?.items ?? [],
  };
}

function isInsightsRunPrompt(prompt: string): boolean {
  return prompt.startsWith("You are the built-in OpenPond Insights agent.") && prompt.includes("Evidence JSON:");
}

function evidencePreviewFromRecord(preview: Record<string, unknown>): EvidenceParseResult {
  const items = arrayValue(preview.items).map(normalizeEvidenceItem).filter((item): item is InsightsRunPromptEvidenceItem => Boolean(item));
  return {
    afterSequence: numberValue(preview.afterSequence),
    eventCount: numberValue(preview.eventCount),
    evidenceSources: stringArray(preview.evidenceSources),
    items,
    latestSequence: numberValue(preview.latestSequence),
    totalEvidenceCount: numberValue(preview.totalCount),
    truncated: Boolean(preview.truncated),
  };
}

function evidenceFromPrompt(prompt: string): EvidenceParseResult | null {
  const marker = "\nEvidence JSON:\n";
  const markerIndex = prompt.indexOf(marker);
  if (markerIndex === -1) return null;
  const rawBody = prompt.slice(markerIndex + marker.length).trim();
  const truncated = rawBody.endsWith("...truncated");
  const body = rawBody.replace(/\n\.\.\.truncated\s*$/, "");
  const parsed = tryParseRecord(body);
  if (parsed) {
    const items = arrayValue(parsed.evidence)
      .map(normalizeEvidenceItem)
      .filter((item): item is InsightsRunPromptEvidenceItem => Boolean(item));
    return {
      afterSequence: numberValue(parsed.afterSequence),
      eventCount: numberValue(parsed.eventCount),
      evidenceSources: stringArray(parsed.evidenceSources),
      items,
      latestSequence: numberValue(parsed.latestSequence),
      totalEvidenceCount: items.length,
      truncated,
    };
  }

  const items = evidenceItemsFromTruncatedBody(body);
  return {
    afterSequence: numberFromJsonField(body, "afterSequence"),
    eventCount: numberFromJsonField(body, "eventCount"),
    evidenceSources: stringArrayFromJsonField(body, "evidenceSources"),
    items,
    latestSequence: numberFromJsonField(body, "latestSequence"),
    totalEvidenceCount: null,
    truncated,
  };
}

function evidenceItemsFromTruncatedBody(body: string): InsightsRunPromptEvidenceItem[] {
  const evidenceIndex = body.indexOf('"evidence"');
  if (evidenceIndex === -1) return [];
  const arrayStart = body.indexOf("[", evidenceIndex);
  if (arrayStart === -1) return [];
  const items: InsightsRunPromptEvidenceItem[] = [];
  let depth = 0;
  let objectStart = -1;
  let inString = false;
  let escaped = false;

  for (let index = arrayStart + 1; index < body.length; index += 1) {
    const char = body[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) objectStart = index;
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0 && objectStart !== -1) {
        const item = normalizeEvidenceItem(tryParseRecord(body.slice(objectStart, index + 1)));
        if (item) items.push(item);
        objectStart = -1;
      }
      continue;
    }
    if (char === "]" && depth === 0) break;
  }
  return items;
}

function normalizeEvidenceItem(value: unknown): InsightsRunPromptEvidenceItem | null {
  const record = asRecord(value);
  if (!record) return null;
  const insight = asRecord(record.insight);
  return {
    evidenceSource: stringValue(record.evidenceSource) ?? "unknown",
    evidenceKey: stringValue(record.evidenceKey) ?? "",
    fingerprint: stringValue(record.fingerprint),
    severity: stringValue(insight?.severity),
    type: stringValue(insight?.type),
    title: stringValue(insight?.title),
    summary: stringValue(insight?.summary),
    sourceSessionId: stringValue(insight?.sourceSessionId),
    sourceTurnId: stringValue(insight?.sourceTurnId),
    createPipelineState: stringValue(insight?.createPipelineState),
    sourceEventSequence: numberValue(insight?.sourceEventSequence),
  };
}

function tryParseRecord(value: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function numberFromJsonField(body: string, field: string): number | null {
  const match = new RegExp(`"${field}"\\s*:\\s*(\\d+)`).exec(body);
  return match ? Number(match[1]) : null;
}

function stringArrayFromJsonField(body: string, field: string): string[] {
  const match = new RegExp(`"${field}"\\s*:\\s*\\[([^\\]]*)\\]`).exec(body);
  if (!match) return [];
  return Array.from(match[1]!.matchAll(/"([^"]+)"/g), (item) => item[1]!).filter(Boolean);
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown): string[] {
  return arrayValue(value).filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
