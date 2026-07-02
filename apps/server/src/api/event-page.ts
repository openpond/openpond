import type { RuntimeEvent } from "@openpond/contracts";

export type RuntimeEventPageEntry = {
  sequence: number;
  event: RuntimeEvent;
};

export type RuntimeEventPagePayload = {
  events: RuntimeEventPageEntry[];
  sessionId: string | null;
  afterSequence: number;
  beforeSequence: number | null;
  nextSequence: number;
  previousSequence: number;
  limit: number;
  hasMore: boolean;
  totalMatchingEvents: number;
  remainingMatchingEvents: number;
};

export type RuntimeEventPageRequest = {
  sessionId: string | null;
  afterSequence: number;
  beforeSequence: number | null;
  limit: number;
};

const DEFAULT_EVENT_PAGE_LIMIT = 100;
const MAX_EVENT_PAGE_LIMIT = 500;

export function runtimeEventsPagePayload(
  events: RuntimeEvent[],
  requestUrl: URL,
): RuntimeEventPagePayload {
  const request = runtimeEventPageRequestFromUrl(requestUrl);
  const matchingBySession = events
    .map((event, index) => ({ sequence: event.sequence ?? index + 1, event }))
    .filter((entry) => !request.sessionId || entry.event.sessionId === request.sessionId);
  if (request.beforeSequence !== null) {
    const matchingBefore = matchingBySession.filter((entry) => entry.sequence < request.beforeSequence!);
    return runtimeEventsPagePayloadFromEntries({
      entries: matchingBefore.slice(-request.limit),
      request,
      totalMatchingEvents: matchingBySession.length,
      remainingMatchingEvents: matchingBefore.length,
    });
  }
  const matching = matchingBySession.filter((entry) => entry.sequence > request.afterSequence);
  return runtimeEventsPagePayloadFromEntries({
    entries: matching.slice(0, request.limit),
    request,
    totalMatchingEvents: matchingBySession.length,
    remainingMatchingEvents: matching.length,
  });
}

export function runtimeEventPageRequestFromUrl(requestUrl: URL): RuntimeEventPageRequest {
  return {
    sessionId: normalizedSearchString(requestUrl.searchParams.get("sessionId")),
    afterSequence: normalizedNonNegativeInteger(
      requestUrl.searchParams.get("afterSequence"),
      0,
    ),
    beforeSequence: normalizedOptionalPositiveInteger(requestUrl.searchParams.get("beforeSequence")),
    limit: normalizedLimit(requestUrl.searchParams.get("limit")),
  };
}

export function runtimeEventsPagePayloadFromEntries(input: {
  entries: RuntimeEventPageEntry[];
  request: RuntimeEventPageRequest;
  totalMatchingEvents: number;
  remainingMatchingEvents: number;
}): RuntimeEventPagePayload {
  const nextSequence = input.entries.at(-1)?.sequence ?? input.request.afterSequence;
  const previousSequence = input.entries[0]?.sequence ?? input.request.beforeSequence ?? input.request.afterSequence;
  return {
    events: input.entries,
    sessionId: input.request.sessionId,
    afterSequence: input.request.afterSequence,
    beforeSequence: input.request.beforeSequence,
    nextSequence,
    previousSequence,
    limit: input.request.limit,
    hasMore: input.remainingMatchingEvents > input.entries.length,
    totalMatchingEvents: input.totalMatchingEvents,
    remainingMatchingEvents: input.remainingMatchingEvents,
  };
}

function normalizedSearchString(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizedLimit(value: string | null): number {
  const parsed = normalizedNonNegativeInteger(value, DEFAULT_EVENT_PAGE_LIMIT);
  if (parsed <= 0) return DEFAULT_EVENT_PAGE_LIMIT;
  return Math.min(MAX_EVENT_PAGE_LIMIT, parsed);
}

function normalizedOptionalPositiveInteger(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizedNonNegativeInteger(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;
  return parsed;
}
