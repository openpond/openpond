import {
  UsageRecordsQuerySchema,
  UsageRecordsResponseSchema,
  UsageSummaryQuerySchema,
  UsageSummaryResponseSchema,
  type ModelUsageRecord,
  type Session,
  type UsageCommandBreakdown,
  type UsageDailyBucket,
  type UsageInsightRunBreakdown,
  type UsageModelBreakdown,
  type UsageRange,
  type UsageRecordsResponse,
  type UsageRouteBreakdown,
  type UsageSourceBreakdown,
  type UsageStatusFilter,
  type UsageStatusBreakdown,
  type UsageSummaryResponse,
  type UsageThreadBreakdown,
  type UsageVisibilityFilter,
} from "@openpond/contracts";

type UsageStore = {
  listModelUsageRecords(query?: {
    sessionId?: string | null;
    turnId?: string | null;
    startedAtFrom?: string | null;
    startedAtTo?: string | null;
    visibility?: UsageVisibilityFilter | null;
    status?: UsageStatusFilter | null;
    limit?: number;
  }): Promise<ModelUsageRecord[]>;
  sessionShells(): Promise<Session[]>;
};

type UsageQueryRange = {
  range: UsageRange;
  startedAtFrom: string | null;
  startedAtTo: string;
};

type BreakdownAccumulator = {
  requests: number;
  promptTokens: number;
  promptTokenRows: number;
  completionTokens: number;
  completionTokenRows: number;
  totalTokens: number;
  totalTokenRows: number;
  durations: number[];
  firstTokenDurations: number[];
  failures: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
};

export async function usageSummaryPayload(input: {
  requestUrl: URL;
  store: UsageStore;
  now?: Date;
}): Promise<UsageSummaryResponse> {
  const query = UsageSummaryQuerySchema.parse({
    range: input.requestUrl.searchParams.get("range") ?? undefined,
    visibility: input.requestUrl.searchParams.get("visibility") ?? undefined,
    status: input.requestUrl.searchParams.get("status") ?? undefined,
  });
  const range = usageQueryRange(query.range, input.now ?? new Date());
  const [records, sessions] = await Promise.all([
    input.store.listModelUsageRecords({
      startedAtFrom: range.startedAtFrom,
      startedAtTo: range.startedAtTo,
      visibility: query.visibility,
      status: query.status,
    }),
    input.store.sessionShells(),
  ]);
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const sortedRecords = [...records].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  const effectiveRange = query.range === "all" && sortedRecords[0]
    ? {
        ...range.range,
        from: sortedRecords[0].startedAt,
      }
    : range.range;
  const response: UsageSummaryResponse = {
    generatedAt: new Date().toISOString(),
    range: effectiveRange,
    filters: {
      visibility: query.visibility,
      status: query.status,
    },
    totals: usageTotals(records),
    daily: dailyBuckets(records),
    models: modelBreakdowns(records),
    threads: threadBreakdowns(records, sessionById),
    commands: commandBreakdowns(records),
    insightRuns: insightRunBreakdowns(records),
    routes: routeBreakdowns(records),
    statuses: statusBreakdowns(records),
    sources: sourceBreakdowns(records),
  };
  return UsageSummaryResponseSchema.parse(response);
}

export async function usageRecordsPayload(input: {
  requestUrl: URL;
  store: UsageStore;
  now?: Date;
}): Promise<UsageRecordsResponse> {
  const query = UsageRecordsQuerySchema.parse({
    range: input.requestUrl.searchParams.get("range") ?? undefined,
    visibility: input.requestUrl.searchParams.get("visibility") ?? undefined,
    status: input.requestUrl.searchParams.get("status") ?? undefined,
    sessionId: input.requestUrl.searchParams.get("sessionId") ?? undefined,
    turnId: input.requestUrl.searchParams.get("turnId") ?? undefined,
    limit: numberParam(input.requestUrl.searchParams.get("limit")),
  });
  const range = usageQueryRange(query.range, input.now ?? new Date());
  const rows = await input.store.listModelUsageRecords({
    sessionId: query.sessionId,
    turnId: query.turnId,
    startedAtFrom: range.startedAtFrom,
    startedAtTo: range.startedAtTo,
    visibility: query.visibility,
    status: query.status,
    limit: query.limit + 1,
  });
  const response: UsageRecordsResponse = {
    generatedAt: new Date().toISOString(),
    range: range.range,
    filters: {
      visibility: query.visibility,
      status: query.status,
      sessionId: query.sessionId ?? null,
      turnId: query.turnId ?? null,
    },
    limit: query.limit,
    hasMore: rows.length > query.limit,
    records: rows.slice(0, query.limit),
  };
  return UsageRecordsResponseSchema.parse(response);
}

function usageQueryRange(range: "7d" | "30d" | "90d" | "all", now: Date): UsageQueryRange {
  const to = now.toISOString();
  if (range === "all") {
    return {
      range: { from: to, to, bucket: "all_time" },
      startedAtFrom: null,
      startedAtTo: to,
    };
  }
  const days = range === "7d" ? 7 : range === "90d" ? 90 : 30;
  const from = startOfLocalDay(addLocalDays(now, -(days - 1)));
  return {
    range: { from: from.toISOString(), to, bucket: "day" },
    startedAtFrom: from.toISOString(),
    startedAtTo: to,
  };
}

function usageTotals(records: ModelUsageRecord[]): UsageSummaryResponse["totals"] {
  const totals = accumulator();
  const models = new Set<string>();
  let completedRequests = 0;
  let failedRequests = 0;
  let missingUsageRequests = 0;
  for (const record of records) {
    addRecord(totals, record);
    models.add(`${record.provider}\u0000${record.model}`);
    if (record.status === "completed") completedRequests += 1;
    if (record.status === "failed") failedRequests += 1;
    if (record.source === "missing") missingUsageRequests += 1;
  }
  return {
    requests: totals.requests,
    completedRequests,
    failedRequests,
    missingUsageRequests,
    promptTokens: nullableTokenTotal(totals.promptTokens, totals.promptTokenRows),
    completionTokens: nullableTokenTotal(totals.completionTokens, totals.completionTokenRows),
    totalTokens: nullableTokenTotal(totals.totalTokens, totals.totalTokenRows),
    averageLatencyMs: average(totals.durations),
    p95LatencyMs: percentile(totals.durations, 0.95),
    averageFirstTokenMs: average(totals.firstTokenDurations),
    p95FirstTokenMs: percentile(totals.firstTokenDurations, 0.95),
    failureRate: failureRate(totals.failures, totals.requests),
    activeModelCount: models.size,
  };
}

function dailyBuckets(records: ModelUsageRecord[]): UsageDailyBucket[] {
  const days = new Map<string, Map<string, { provider: ModelUsageRecord["provider"]; model: string; totalTokens: number; requests: number }>>();
  for (const record of records) {
    const date = localDateKey(record.startedAt);
    const modelKey = `${record.provider}\u0000${record.model}`;
    let models = days.get(date);
    if (!models) {
      models = new Map();
      days.set(date, models);
    }
    const current = models.get(modelKey) ?? {
      provider: record.provider,
      model: record.model,
      totalTokens: 0,
      requests: 0,
    };
    current.totalTokens += record.totalTokens ?? 0;
    current.requests += 1;
    models.set(modelKey, current);
  }
  return [...days.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, models]) => {
      const modelRows = [...models.values()].sort((left, right) =>
        right.totalTokens - left.totalTokens || right.requests - left.requests || left.model.localeCompare(right.model)
      );
      return {
        date,
        totalTokens: modelRows.reduce((sum, row) => sum + row.totalTokens, 0),
        requests: modelRows.reduce((sum, row) => sum + row.requests, 0),
        models: modelRows,
      };
    });
}

function modelBreakdowns(records: ModelUsageRecord[]): UsageModelBreakdown[] {
  const groups = new Map<string, { provider: ModelUsageRecord["provider"]; model: string; route: ModelUsageRecord["route"]; totals: BreakdownAccumulator }>();
  for (const record of records) {
    const key = `${record.provider}\u0000${record.model}\u0000${record.route}`;
    const group = groups.get(key) ?? {
      provider: record.provider,
      model: record.model,
      route: record.route,
      totals: accumulator(),
    };
    addRecord(group.totals, record);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({
      provider: group.provider,
      model: group.model,
      route: group.route,
      ...breakdownTotals(group.totals),
    }))
    .sort(breakdownSort);
}

function threadBreakdowns(
  records: ModelUsageRecord[],
  sessionById: Map<string, Session>,
): UsageThreadBreakdown[] {
  const groups = new Map<string, BreakdownAccumulator>();
  for (const record of records) {
    if (!record.sessionId) continue;
    const totals = groups.get(record.sessionId) ?? accumulator();
    addRecord(totals, record);
    groups.set(record.sessionId, totals);
  }
  return [...groups.entries()]
    .map(([sessionId, totals]) => {
      const session = sessionById.get(sessionId);
      return {
        sessionId,
        title: session?.title ?? null,
        workspaceKind: session?.workspaceKind ?? null,
        workspaceId: session?.workspaceId ?? null,
        ...breakdownTotals(totals),
      };
    })
    .sort(breakdownSort);
}

function commandBreakdowns(records: ModelUsageRecord[]): UsageCommandBreakdown[] {
  const groups = new Map<string, { commandName: string; commandSource: UsageCommandBreakdown["commandSource"]; totals: BreakdownAccumulator }>();
  for (const record of records) {
    const commandName = record.attribution.commandName;
    if (!commandName) continue;
    const commandSource = record.attribution.commandSource;
    const key = `${commandName}\u0000${commandSource ?? ""}`;
    const group = groups.get(key) ?? {
      commandName,
      commandSource,
      totals: accumulator(),
    };
    addRecord(group.totals, record);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({
      commandName: group.commandName,
      commandSource: group.commandSource,
      ...breakdownTotals(group.totals),
    }))
    .sort(breakdownSort);
}

function insightRunBreakdowns(records: ModelUsageRecord[]): UsageInsightRunBreakdown[] {
  const groups = new Map<string, BreakdownAccumulator>();
  for (const record of records) {
    const insightRunId = record.attribution.insightRunId;
    if (!insightRunId) continue;
    const totals = groups.get(insightRunId) ?? accumulator();
    addRecord(totals, record);
    groups.set(insightRunId, totals);
  }
  return [...groups.entries()]
    .map(([insightRunId, totals]) => ({
      insightRunId,
      status: null,
      trigger: null,
      findingCount: null,
      sessionId: null,
      turnId: null,
      ...breakdownTotals(totals),
    }))
    .sort(breakdownSort);
}

function routeBreakdowns(records: ModelUsageRecord[]): UsageRouteBreakdown[] {
  const groups = new Map<ModelUsageRecord["route"], BreakdownAccumulator>();
  for (const record of records) {
    const totals = groups.get(record.route) ?? accumulator();
    addRecord(totals, record);
    groups.set(record.route, totals);
  }
  return [...groups.entries()]
    .map(([route, totals]) => ({
      route,
      ...breakdownTotals(totals),
    }))
    .sort(breakdownSort);
}

function statusBreakdowns(records: ModelUsageRecord[]): UsageStatusBreakdown[] {
  const groups = new Map<ModelUsageRecord["status"], BreakdownAccumulator>();
  for (const record of records) {
    const totals = groups.get(record.status) ?? accumulator();
    addRecord(totals, record);
    groups.set(record.status, totals);
  }
  return [...groups.entries()]
    .map(([status, totals]) => ({
      status,
      ...breakdownTotals(totals),
    }))
    .sort(breakdownSort);
}

function sourceBreakdowns(records: ModelUsageRecord[]): UsageSourceBreakdown[] {
  const groups = new Map<ModelUsageRecord["source"], BreakdownAccumulator>();
  for (const record of records) {
    const totals = groups.get(record.source) ?? accumulator();
    addRecord(totals, record);
    groups.set(record.source, totals);
  }
  return [...groups.entries()]
    .map(([source, totals]) => ({
      source,
      ...breakdownTotals(totals),
    }))
    .sort(breakdownSort);
}

function accumulator(): BreakdownAccumulator {
  return {
    requests: 0,
    promptTokens: 0,
    promptTokenRows: 0,
    completionTokens: 0,
    completionTokenRows: 0,
    totalTokens: 0,
    totalTokenRows: 0,
    durations: [],
    firstTokenDurations: [],
    failures: 0,
    firstSeenAt: null,
    lastSeenAt: null,
  };
}

function addRecord(accumulator: BreakdownAccumulator, record: ModelUsageRecord): void {
  accumulator.requests += 1;
  if (record.promptTokens !== null) {
    accumulator.promptTokens += record.promptTokens;
    accumulator.promptTokenRows += 1;
  }
  if (record.completionTokens !== null) {
    accumulator.completionTokens += record.completionTokens;
    accumulator.completionTokenRows += 1;
  }
  if (record.totalTokens !== null) {
    accumulator.totalTokens += record.totalTokens;
    accumulator.totalTokenRows += 1;
  }
  if (record.durationMs !== null) accumulator.durations.push(record.durationMs);
  if (record.firstTokenMs !== null) accumulator.firstTokenDurations.push(record.firstTokenMs);
  if (record.status === "failed" || record.status === "interrupted") accumulator.failures += 1;
  if (!accumulator.firstSeenAt || record.startedAt < accumulator.firstSeenAt) {
    accumulator.firstSeenAt = record.startedAt;
  }
  if (!accumulator.lastSeenAt || record.startedAt > accumulator.lastSeenAt) {
    accumulator.lastSeenAt = record.startedAt;
  }
}

function breakdownTotals(accumulator: BreakdownAccumulator) {
  return {
    requests: accumulator.requests,
    promptTokens: nullableTokenTotal(accumulator.promptTokens, accumulator.promptTokenRows),
    completionTokens: nullableTokenTotal(accumulator.completionTokens, accumulator.completionTokenRows),
    totalTokens: nullableTokenTotal(accumulator.totalTokens, accumulator.totalTokenRows),
    averageLatencyMs: average(accumulator.durations),
    p95LatencyMs: percentile(accumulator.durations, 0.95),
    averageFirstTokenMs: average(accumulator.firstTokenDurations),
    p95FirstTokenMs: percentile(accumulator.firstTokenDurations, 0.95),
    failures: accumulator.failures,
    failureRate: failureRate(accumulator.failures, accumulator.requests),
    firstSeenAt: accumulator.firstSeenAt ?? new Date(0).toISOString(),
    lastSeenAt: accumulator.lastSeenAt ?? new Date(0).toISOString(),
  };
}

function failureRate(failures: number, requests: number): number {
  if (requests <= 0) return 0;
  return Number((failures / requests).toFixed(4));
}

function nullableTokenTotal(total: number, rows: number): number | null {
  return rows > 0 ? total : null;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function percentile(values: number[], ratio: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? null;
}

function breakdownSort<T extends { totalTokens: number | null; requests: number; lastSeenAt: string }>(left: T, right: T): number {
  return (right.totalTokens ?? -1) - (left.totalTokens ?? -1) ||
    right.requests - left.requests ||
    right.lastSeenAt.localeCompare(left.lastSeenAt);
}

function localDateKey(timestamp: string): string {
  const date = new Date(timestamp);
  return [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
  ].join("-");
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addLocalDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

function numberParam(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
