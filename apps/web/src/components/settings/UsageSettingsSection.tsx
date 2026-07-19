import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  ModelUsageRecord,
  UsageCommandBreakdown,
  UsageDailyBucket,
  UsageInsightRunBreakdown,
  UsageModelBreakdown,
  UsageRecordsResponse,
  UsageRouteBreakdown,
  UsageSourceBreakdown,
  UsageStatusBreakdown,
  UsageStatusFilter,
  UsageSummaryResponse,
  UsageThreadBreakdown,
  UsageVisibilityFilter,
} from "@openpond/contracts";
import { api, type ClientConnection } from "../../api";
import { ArrowUpRight, Loader2, RefreshCw } from "../icons";

type UsageRangeFilter = "7d" | "30d" | "90d" | "all";

type UsageSettingsSectionProps = {
  connection: ClientConnection | null;
  enabled: boolean;
  onError: (message: string | null) => void;
  onOpenSourceSession?: (sessionId: string) => void;
};

type UsageSettingsContentProps = {
  summary: UsageSummaryResponse | null;
  recordsResponse: UsageRecordsResponse | null;
  loading: boolean;
  error: string | null;
  range: UsageRangeFilter;
  visibility: UsageVisibilityFilter;
  status: UsageStatusFilter;
  onRangeChange?: (range: UsageRangeFilter) => void;
  onVisibilityChange?: (visibility: UsageVisibilityFilter) => void;
  onStatusChange?: (status: UsageStatusFilter) => void;
  onRefresh?: () => void;
  onOpenSourceSession?: (sessionId: string) => void;
};

type UsageChartSeries = {
  dataKey: string;
  label: string;
  color: string;
};

type UsageChartRow = {
  date: string;
  label: string;
  requests: number;
  totalTokens: number;
  [key: string]: number | string;
};

type UsageTableColumn<T> = {
  key: string;
  label: string;
  align?: "start" | "end";
  render: (row: T) => ReactNode;
};

const RANGE_OPTIONS: Array<{ value: UsageRangeFilter; label: string }> = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "all", label: "All time" },
];

const VISIBILITY_OPTIONS: Array<{ value: UsageVisibilityFilter; label: string }> = [
  { value: "all", label: "All calls" },
  { value: "user_facing", label: "User-facing" },
  { value: "background", label: "Background" },
  { value: "system", label: "System" },
];

const STATUS_OPTIONS: Array<{ value: UsageStatusFilter; label: string }> = [
  { value: "all", label: "All statuses" },
  { value: "started", label: "Started" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "interrupted", label: "Interrupted" },
  { value: "missing", label: "Missing usage" },
];

const MAX_CHART_SERIES = 8;
const CHART_COLORS = [
  "#5b8def",
  "#41b883",
  "#f2a65a",
  "#d66ba0",
  "#8f7ee7",
  "#4fb6c2",
  "#d6c15c",
  "#9b9b9b",
];

const integerFormatter = new Intl.NumberFormat("en-US");
const compactNumberFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const percentFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
});
const shortDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});
const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function UsageSettingsSection({ connection, enabled, onError, onOpenSourceSession }: UsageSettingsSectionProps) {
  const [range, setRange] = useState<UsageRangeFilter>("30d");
  const [visibility, setVisibility] = useState<UsageVisibilityFilter>("all");
  const [status, setStatus] = useState<UsageStatusFilter>("all");
  const [summary, setSummary] = useState<UsageSummaryResponse | null>(null);
  const [recordsResponse, setRecordsResponse] = useState<UsageRecordsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshSerial, setRefreshSerial] = useState(0);

  const refresh = useCallback(() => {
    setRefreshSerial((current) => current + 1);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (!connection) {
      setSummary(null);
      setRecordsResponse(null);
      setLoading(false);
      setError("Usage data is unavailable");
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all([
      api.usage(connection, { range, visibility, status }),
      api.usageRecords(connection, { range, visibility, status, limit: 100 }),
    ])
      .then(([nextSummary, nextRecords]) => {
        if (cancelled) return;
        setSummary(nextSummary);
        setRecordsResponse(nextRecords);
        setError(null);
        onError(null);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        const message = reason instanceof Error ? reason.message : "Failed to load usage";
        setError(message);
        onError(message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [connection, enabled, onError, range, refreshSerial, status, visibility]);

  return (
    <UsageSettingsContent
      summary={summary}
      recordsResponse={recordsResponse}
      loading={loading}
      error={error}
      range={range}
      visibility={visibility}
      status={status}
      onRangeChange={setRange}
      onVisibilityChange={setVisibility}
      onStatusChange={setStatus}
      onRefresh={refresh}
      onOpenSourceSession={onOpenSourceSession}
    />
  );
}

export function UsageSettingsContent({
  summary,
  recordsResponse,
  loading,
  error,
  range,
  visibility,
  status,
  onRangeChange,
  onVisibilityChange,
  onStatusChange,
  onRefresh,
  onOpenSourceSession,
}: UsageSettingsContentProps) {
  const chart = useMemo(() => buildUsageChart(summary?.daily ?? []), [summary]);
  const threadTableColumns = useMemo(
    () => withSourceActionColumn(threadColumns, onOpenSourceSession, (row) => row.sessionId, "Open thread"),
    [onOpenSourceSession],
  );
  const insightTableColumns = useMemo(
    () => withSourceActionColumn(insightColumns, onOpenSourceSession, (row) => row.sessionId, "Open Insight session"),
    [onOpenSourceSession],
  );
  const requestTableColumns = useMemo(
    () => withSourceActionColumn(requestColumns, onOpenSourceSession, (row) => row.sessionId, "Open request source"),
    [onOpenSourceSession],
  );
  const records = recordsResponse?.records ?? [];
  const totals = summary?.totals ?? null;
  const hasUsage = Boolean(summary && summary.totals.requests > 0);

  return (
    <section className="account-settings usage-settings">
      <div className="account-settings-title usage-settings-title">
        <h1>Usage</h1>
        <button
          type="button"
          className="settings-icon-button"
          title="Refresh usage"
          aria-label="Refresh usage"
          disabled={loading || !onRefresh}
          onClick={onRefresh}
        >
          <RefreshCw size={15} className={loading ? "settings-spin" : undefined} />
        </button>
      </div>

      <div className="usage-toolbar">
        <div className="usage-range-control" role="group" aria-label="Usage range">
          {RANGE_OPTIONS.map((option) => (
            <button
              type="button"
              key={option.value}
              className={range === option.value ? "active" : ""}
              disabled={!onRangeChange}
              onClick={() => onRangeChange?.(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <label className="usage-filter-control">
          <span>Visibility</span>
          <select value={visibility} disabled={!onVisibilityChange} onChange={(event) => onVisibilityChange?.(event.target.value as UsageVisibilityFilter)}>
            {VISIBILITY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="usage-filter-control">
          <span>Status</span>
          <select value={status} disabled={!onStatusChange} onChange={(event) => onStatusChange?.(event.target.value as UsageStatusFilter)}>
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error ? (
        <div className="settings-footnote usage-load-state">
          <span>{error}</span>
        </div>
      ) : null}

      <UsageMetrics totals={totals} loading={loading && !summary} />

      <UsagePanel title="Daily tokens">
        <UsageTokenChart chart={chart} loading={loading && !summary} />
      </UsagePanel>

      {summary && !hasUsage ? (
        <div className="account-list usage-empty-state">
          <strong>No usage records</strong>
          <span>Calls will appear after the next model request.</span>
        </div>
      ) : null}

      <UsageDataTable
        title="Models"
        rows={summary?.models ?? []}
        rowKey={(row) => `${row.provider}:${row.model}:${row.route}`}
        emptyLabel="No model usage"
        columns={modelColumns}
      />

      <UsageDataTable
        title="Threads"
        rows={summary?.threads ?? []}
        rowKey={(row) => row.sessionId}
        emptyLabel="No thread usage"
        columns={threadTableColumns}
      />

      <UsageDataTable
        title="Slash commands"
        rows={summary?.commands ?? []}
        rowKey={(row) => `${row.commandName}:${row.commandSource ?? "unknown"}`}
        emptyLabel="No command usage"
        columns={commandColumns}
      />

      <UsageDataTable
        title="Insight runs"
        rows={summary?.insightRuns ?? []}
        rowKey={(row) => row.insightRunId}
        emptyLabel="No Insight usage"
        columns={insightTableColumns}
      />

      <div className="usage-breakdown-grid">
        <UsageDataTable
          title="Routes"
          rows={summary?.routes ?? []}
          rowKey={(row) => row.route}
          emptyLabel="No route usage"
          columns={routeColumns}
          compact
        />
        <UsageDataTable
          title="Statuses"
          rows={summary?.statuses ?? []}
          rowKey={(row) => row.status}
          emptyLabel="No status usage"
          columns={statusColumns}
          compact
        />
        <UsageDataTable
          title="Sources"
          rows={summary?.sources ?? []}
          rowKey={(row) => row.source}
          emptyLabel="No source usage"
          columns={sourceColumns}
          compact
        />
      </div>

      <UsageDataTable
        title="Requests"
        rows={records}
        rowKey={(row) => row.id}
        emptyLabel="No requests"
        columns={requestTableColumns}
        footer={recordsResponse?.hasMore ? `Showing ${records.length} recent requests` : null}
      />
    </section>
  );
}

function withSourceActionColumn<T>(
  columns: Array<UsageTableColumn<T>>,
  onOpenSourceSession: ((sessionId: string) => void) | undefined,
  sessionIdForRow: (row: T) => string | null,
  label: string,
): Array<UsageTableColumn<T>> {
  if (!onOpenSourceSession) return columns;
  return [
    ...columns,
    {
      key: "open-source",
      label: "Open",
      align: "end",
      render: (row) => {
        const sessionId = sessionIdForRow(row);
        if (!sessionId) return <span aria-hidden="true" />;
        return <UsageSourceAction label={label} sessionId={sessionId} onOpenSourceSession={onOpenSourceSession} />;
      },
    },
  ];
}

function UsageMetrics({ totals, loading }: { totals: UsageSummaryResponse["totals"] | null; loading: boolean }) {
  const metrics = [
    { label: "Total tokens", value: totals ? formatTokens(totals.totalTokens) : loading ? "Loading" : "0" },
    { label: "Requests", value: totals ? formatInteger(totals.requests) : loading ? "Loading" : "0" },
    { label: "Average latency", value: totals ? formatDuration(totals.averageLatencyMs) : loading ? "Loading" : "missing" },
    { label: "p95 latency", value: totals ? formatDuration(totals.p95LatencyMs) : loading ? "Loading" : "missing" },
    { label: "First token p95", value: totals ? formatDuration(totals.p95FirstTokenMs) : loading ? "Loading" : "missing" },
    { label: "Failed requests", value: totals ? formatInteger(totals.failedRequests) : loading ? "Loading" : "0" },
    { label: "Missing usage", value: totals ? formatInteger(totals.missingUsageRequests) : loading ? "Loading" : "0" },
    { label: "Models", value: totals ? formatInteger(totals.activeModelCount) : loading ? "Loading" : "0" },
  ];

  return (
    <div className="usage-metric-grid">
      {metrics.map((metric) => (
        <div className="usage-metric" key={metric.label}>
          <span>{metric.label}</span>
          <strong>{metric.value}</strong>
        </div>
      ))}
    </div>
  );
}

function UsagePanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="account-list usage-panel">
      <div className="account-list-heading">
        <span>{title}</span>
      </div>
      {children}
    </div>
  );
}

function UsageTokenChart({
  chart,
  loading,
}: {
  chart: { rows: UsageChartRow[]; series: UsageChartSeries[] };
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="usage-chart-empty">
        <Loader2 className="settings-spin" size={16} />
        <span>Loading usage</span>
      </div>
    );
  }

  if (chart.rows.length === 0 || chart.series.length === 0) {
    return <div className="usage-chart-empty">No daily tokens</div>;
  }

  return (
    <div className="usage-chart-frame">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chart.rows} margin={{ top: 18, right: 10, bottom: 2, left: -8 }}>
          <CartesianGrid stroke="rgba(255, 255, 255, 0.06)" vertical={false} />
          <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: "#9b9b9b", fontSize: 11 }} />
          <YAxis
            axisLine={false}
            tickLine={false}
            tick={{ fill: "#9b9b9b", fontSize: 11 }}
            tickFormatter={(value) => formatCompactNumber(Number(value))}
          />
          <Tooltip content={<UsageChartTooltip />} cursor={{ fill: "rgba(255, 255, 255, 0.04)" }} />
          <Legend iconType="square" wrapperStyle={{ color: "#c8c8c8", fontSize: 11, paddingTop: 8 }} />
          {chart.series.map((series) => (
            <Bar
              key={series.dataKey}
              dataKey={series.dataKey}
              name={series.label}
              stackId="tokens"
              fill={series.color}
              radius={[3, 3, 0, 0]}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function UsageChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ color?: string; name?: string; value?: number | string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  const rows = payload
    .map((item) => ({
      color: item.color ?? "#9b9b9b",
      name: item.name ?? "Model",
      value: numericValue(item.value),
    }))
    .filter((item) => item.value > 0);
  if (rows.length === 0) return null;
  return (
    <div className="usage-chart-tooltip">
      <strong>{label}</strong>
      {rows.map((row) => (
        <div key={row.name}>
          <span style={{ backgroundColor: row.color }} />
          <small>{row.name}</small>
          <em>{formatTokens(row.value)}</em>
        </div>
      ))}
    </div>
  );
}

function UsageDataTable<T>({
  title,
  rows,
  rowKey,
  columns,
  emptyLabel,
  footer,
  compact = false,
}: {
  title: string;
  rows: T[];
  rowKey: (row: T, index: number) => string;
  columns: Array<UsageTableColumn<T>>;
  emptyLabel: string;
  footer?: string | null;
  compact?: boolean;
}) {
  return (
    <div className={`account-list usage-table-panel ${compact ? "compact" : ""}`}>
      <div className="account-list-heading">
        <span>{title}</span>
        <small>{rows.length ? formatInteger(rows.length) : ""}</small>
      </div>
      {rows.length === 0 ? (
        <div className="usage-table-empty">{emptyLabel}</div>
      ) : (
        <div className="usage-table-scroll">
          <table className="usage-table">
            <thead>
              <tr>
                {columns.map((column) => (
                  <th className={column.align === "end" ? "align-end" : undefined} key={column.key}>
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={rowKey(row, index)}>
                  {columns.map((column) => (
                    <td className={column.align === "end" ? "align-end" : undefined} key={column.key}>
                      {column.render(row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {footer ? <div className="usage-table-footer">{footer}</div> : null}
        </div>
      )}
    </div>
  );
}

const modelColumns: Array<UsageTableColumn<UsageModelBreakdown>> = [
  {
    key: "model",
    label: "Model",
    render: (row) => <UsagePrimaryCell title={row.model} detail={`${providerLabel(row.provider)} / ${routeLabel(row.route)}`} />,
  },
  { key: "tokens", label: "Tokens", align: "end", render: (row) => formatTokens(row.totalTokens) },
  { key: "requests", label: "Requests", align: "end", render: (row) => formatInteger(row.requests) },
  { key: "latency", label: "p95 latency", align: "end", render: (row) => formatDuration(row.p95LatencyMs) },
  { key: "first-token", label: "First token", align: "end", render: (row) => formatDuration(row.p95FirstTokenMs) },
  { key: "failure-rate", label: "Failure rate", align: "end", render: (row) => formatPercent(row.failureRate) },
];

const threadColumns: Array<UsageTableColumn<UsageThreadBreakdown>> = [
  {
    key: "thread",
    label: "Thread",
    render: (row) => <UsagePrimaryCell title={row.title ?? "Untitled thread"} detail={shortId(row.sessionId)} />,
  },
  { key: "tokens", label: "Tokens", align: "end", render: (row) => formatTokens(row.totalTokens) },
  { key: "requests", label: "Requests", align: "end", render: (row) => formatInteger(row.requests) },
  { key: "latency", label: "p95 latency", align: "end", render: (row) => formatDuration(row.p95LatencyMs) },
  { key: "last-seen", label: "Last seen", align: "end", render: (row) => formatDateTime(row.lastSeenAt) },
];

const commandColumns: Array<UsageTableColumn<UsageCommandBreakdown>> = [
  {
    key: "command",
    label: "Command",
    render: (row) => <UsagePrimaryCell title={row.commandName} detail={commandSourceLabel(row.commandSource)} />,
  },
  { key: "tokens", label: "Tokens", align: "end", render: (row) => formatTokens(row.totalTokens) },
  { key: "requests", label: "Requests", align: "end", render: (row) => formatInteger(row.requests) },
  { key: "latency", label: "p95 latency", align: "end", render: (row) => formatDuration(row.p95LatencyMs) },
  { key: "failure-rate", label: "Failure rate", align: "end", render: (row) => formatPercent(row.failureRate) },
];

const insightColumns: Array<UsageTableColumn<UsageInsightRunBreakdown>> = [
  {
    key: "run",
    label: "Run",
    render: (row) => <UsagePrimaryCell title={shortId(row.insightRunId)} detail={[row.status, row.trigger].filter(Boolean).join(" / ") || "Insight run"} />,
  },
  { key: "tokens", label: "Tokens", align: "end", render: (row) => formatTokens(row.totalTokens) },
  { key: "requests", label: "Requests", align: "end", render: (row) => formatInteger(row.requests) },
  { key: "findings", label: "Findings", align: "end", render: (row) => nullableInteger(row.findingCount) },
  { key: "latency", label: "p95 latency", align: "end", render: (row) => formatDuration(row.p95LatencyMs) },
];

const routeColumns: Array<UsageTableColumn<UsageRouteBreakdown>> = [
  { key: "route", label: "Route", render: (row) => routeLabel(row.route) },
  { key: "requests", label: "Requests", align: "end", render: (row) => formatInteger(row.requests) },
  { key: "tokens", label: "Tokens", align: "end", render: (row) => formatTokens(row.totalTokens) },
];

const statusColumns: Array<UsageTableColumn<UsageStatusBreakdown>> = [
  { key: "status", label: "Status", render: (row) => statusLabel(row.status) },
  { key: "requests", label: "Requests", align: "end", render: (row) => formatInteger(row.requests) },
  { key: "tokens", label: "Tokens", align: "end", render: (row) => formatTokens(row.totalTokens) },
];

const sourceColumns: Array<UsageTableColumn<UsageSourceBreakdown>> = [
  { key: "source", label: "Source", render: (row) => sourceLabel(row.source) },
  { key: "requests", label: "Requests", align: "end", render: (row) => formatInteger(row.requests) },
  { key: "tokens", label: "Tokens", align: "end", render: (row) => formatTokens(row.totalTokens) },
];

const requestColumns: Array<UsageTableColumn<ModelUsageRecord>> = [
  { key: "started", label: "Started", render: (row) => formatDateTime(row.startedAt) },
  {
    key: "model",
    label: "Model",
    render: (row) => <UsagePrimaryCell title={row.model} detail={providerLabel(row.provider)} />,
  },
  {
    key: "route",
    label: "Route",
    render: (row) => <UsagePrimaryCell title={routeLabel(row.route)} detail={statusLabel(row.status)} />,
  },
  { key: "kind", label: "Kind", render: (row) => requestKindLabel(row.requestKind) },
  { key: "tokens", label: "Tokens", align: "end", render: (row) => formatTokens(row.totalTokens) },
  { key: "latency", label: "Latency", align: "end", render: (row) => formatDuration(row.durationMs) },
  {
    key: "context",
    label: "Context",
    render: (row) => requestContext(row),
  },
];

function UsagePrimaryCell({ title, detail }: { title: string; detail: string }) {
  return (
    <span className="usage-primary-cell">
      <strong>{title}</strong>
      <small>{detail}</small>
    </span>
  );
}

function UsageSourceAction({
  label,
  sessionId,
  onOpenSourceSession,
}: {
  label: string;
  sessionId: string;
  onOpenSourceSession: (sessionId: string) => void;
}) {
  return (
    <button
      type="button"
      className="settings-icon-button ghost usage-source-action"
      title={label}
      aria-label={label}
      onClick={() => onOpenSourceSession(sessionId)}
    >
      <ArrowUpRight size={14} />
    </button>
  );
}

function buildUsageChart(daily: UsageDailyBucket[]): { rows: UsageChartRow[]; series: UsageChartSeries[] } {
  const modelTotals = new Map<string, { provider: string; model: string; totalTokens: number; requests: number }>();
  for (const bucket of daily) {
    for (const model of bucket.models) {
      const key = usageModelKey(model.provider, model.model);
      const current = modelTotals.get(key) ?? {
        provider: model.provider,
        model: model.model,
        totalTokens: 0,
        requests: 0,
      };
      current.totalTokens += model.totalTokens;
      current.requests += model.requests;
      modelTotals.set(key, current);
    }
  }

  const sortedModels = [...modelTotals.values()].sort(
    (left, right) => right.totalTokens - left.totalTokens || right.requests - left.requests || left.model.localeCompare(right.model),
  );
  const visibleModelCount = sortedModels.length > MAX_CHART_SERIES ? MAX_CHART_SERIES - 1 : MAX_CHART_SERIES;
  const visibleModels = sortedModels.slice(0, visibleModelCount);
  const visibleKeys = new Map<string, string>();
  const series = visibleModels.map((model, index) => {
    const dataKey = `model${index}`;
    visibleKeys.set(usageModelKey(model.provider, model.model), dataKey);
    return {
      dataKey,
      label: model.model,
      color: CHART_COLORS[index % CHART_COLORS.length],
    };
  });
  const includeOther = sortedModels.length > visibleModels.length;
  if (includeOther) {
    series.push({
      dataKey: "otherModels",
      label: "Other models",
      color: CHART_COLORS[Math.min(series.length, CHART_COLORS.length - 1)],
    });
  }

  const rows = daily.map((bucket) => {
    const row: UsageChartRow = {
      date: bucket.date,
      label: formatShortDate(bucket.date),
      requests: bucket.requests,
      totalTokens: bucket.totalTokens,
    };
    for (const item of series) row[item.dataKey] = 0;
    let otherTotal = 0;
    for (const model of bucket.models) {
      const dataKey = visibleKeys.get(usageModelKey(model.provider, model.model));
      if (dataKey) {
        row[dataKey] = numericValue(row[dataKey]) + model.totalTokens;
      } else {
        otherTotal += model.totalTokens;
      }
    }
    if (includeOther) row.otherModels = otherTotal;
    return row;
  });

  return { rows, series };
}

function usageModelKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`;
}

function formatInteger(value: number): string {
  return integerFormatter.format(value);
}

function nullableInteger(value: number | null): string {
  return value === null ? "missing" : formatInteger(value);
}

function formatCompactNumber(value: number): string {
  return compactNumberFormatter.format(value);
}

function formatTokens(value: number | null): string {
  if (value === null) return "missing";
  if (value >= 10_000) return compactNumberFormatter.format(value);
  return integerFormatter.format(value);
}

function formatDuration(value: number | null): string {
  if (value === null) return "missing";
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}s`;
  return `${integerFormatter.format(Math.round(value))}ms`;
}

function formatPercent(value: number): string {
  return `${percentFormatter.format(value * 100)}%`;
}

function formatShortDate(value: string): string {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return shortDateFormatter.format(date);
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return dateTimeFormatter.format(date);
}

function numericValue(value: number | string | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function providerLabel(provider: string): string {
  if (provider === "openai") return "OpenAI";
  if (provider === "anthropic") return "Anthropic";
  if (provider === "google") return "Google";
  if (provider === "openpond") return "OpenPond";
  if (provider === "openrouter") return "OpenRouter";
  if (provider === "codex") return "Codex";
  return titleFromIdentifier(provider);
}

function routeLabel(route: string): string {
  if (route === "openpond_hosted") return "OpenPond hosted";
  if (route === "local_byok") return "Local BYOK";
  if (route === "codex_app_server") return "Codex app server";
  return "Unknown";
}

function sourceLabel(source: string): string {
  if (source === "provider_usage") return "Provider usage";
  if (source === "codex_context_usage") return "Codex context";
  if (source === "missing") return "Missing";
  return titleFromIdentifier(source);
}

function statusLabel(status: string): string {
  return titleFromIdentifier(status);
}

function commandSourceLabel(source: UsageCommandBreakdown["commandSource"]): string {
  if (!source) return "Unknown source";
  if (source === "composer_selection") return "Composer selection";
  if (source === "prompt_parse") return "Prompt parse";
  if (source === "server_parser") return "Server parser";
  if (source === "model_tool") return "Model tool";
  return titleFromIdentifier(source);
}

function requestKindLabel(kind: string): string {
  if (kind === "chat_turn") return "Chat turn";
  if (kind === "tool_loop") return "Tool loop";
  if (kind === "slash_command") return "Slash command";
  if (kind === "create_improve_planner") return "Create/Improve planner";
  if (kind === "context_compaction") return "Compaction";
  if (kind === "insights_scan") return "Insight scan";
  if (kind === "insights_question") return "Insight question";
  if (kind === "goal_control") return "Goal control";
  if (kind === "subagent") return "Subagent";
  if (kind === "codex_context") return "Codex context";
  return "Other";
}

function requestContext(row: ModelUsageRecord): ReactNode {
  if (row.attribution.commandName) return row.attribution.commandName;
  if (row.sessionId) return shortId(row.sessionId);
  if (row.attribution.insightRunId) return shortId(row.attribution.insightRunId);
  return "None";
}

function titleFromIdentifier(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function shortId(value: string): string {
  if (value.length <= 14) return value;
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}
