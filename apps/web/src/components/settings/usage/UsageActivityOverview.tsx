import { useMemo, useState, type CSSProperties } from "react";
import type {
  AccountState,
  UsageDailyBucket,
  UsageModelBreakdown,
  UsageSummaryResponse,
} from "@openpond/contracts";
import { Activity, Loader2 } from "../../icons";

type ActivityMode = "daily" | "weekly" | "cumulative";

type ActivityDay = {
  date: string;
  future: boolean;
  requests: number;
  totalTokens: number;
  models: ActivityDayModel[];
};

type ActivityDayModel = UsageDailyBucket["models"][number];

type ActivityWeek = {
  days: ActivityDay[];
  firstDate: string;
  totalTokens: number;
};

type ModelColor = {
  color: string;
  key: string;
  model: string;
  provider: UsageModelBreakdown["provider"];
};

type HoveredActivityDay = {
  day: ActivityDay;
  left: number;
  top: number;
};

const MODEL_COLORS = [
  "#67b7ff",
  "#9b82ff",
  "#ea74ca",
  "#ff8b78",
  "#f6bd5c",
  "#55d6ad",
  "#49c6e5",
  "#7f9cff",
  "#c879ff",
  "#8bd35f",
];

const integerFormatter = new Intl.NumberFormat("en-US");
const compactNumberFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const longDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});
const monthFormatter = new Intl.DateTimeFormat("en-US", { month: "short" });

export function UsageActivityOverview({
  account,
  summary,
  loading,
  range,
}: {
  account: AccountState | null;
  summary: UsageSummaryResponse | null;
  loading: boolean;
  range: "7d" | "30d" | "90d" | "all";
}) {
  const [activityMode, setActivityMode] = useState<ActivityMode>("daily");
  const calendar = useMemo(
    () => buildActivityCalendar(summary?.daily ?? [], summary?.range.to ?? summary?.generatedAt),
    [summary],
  );
  const modelColors = useMemo(
    () => buildModelColors(summary?.models ?? [], summary?.daily ?? []),
    [summary],
  );
  const colorByModel = useMemo(
    () => new Map(modelColors.map((model) => [model.key, model.color])),
    [modelColors],
  );
  const identity = usageIdentity(account);
  const totals = summary?.totals ?? null;
  const topModel = aggregateModelRows(summary?.models ?? [])[0] ?? null;
  const successRate = totals?.requests
    ? totals.completedRequests / totals.requests
    : 0;
  const completionShare = totals && totals.promptTokens !== null && totals.completionTokens !== null
    ? totals.completionTokens / Math.max(1, totals.promptTokens + totals.completionTokens)
    : null;
  const metrics = [
    {
      label: range === "all" ? "Lifetime tokens" : "Tokens in range",
      value: totals ? formatTokens(totals.totalTokens) : loading ? "Loading" : "0",
    },
    {
      label: "Peak day",
      value: totals ? formatTokens(totals.peakDailyTokens) : loading ? "Loading" : "0",
    },
    {
      label: "Longest request",
      value: totals ? formatLongDuration(totals.longestRequestMs) : loading ? "Loading" : "—",
    },
    {
      label: "Current streak",
      value: totals ? formatDays(totals.currentStreakDays) : loading ? "Loading" : "0 days",
    },
    {
      label: "Longest streak",
      value: totals ? formatDays(totals.longestStreakDays) : loading ? "Loading" : "0 days",
    },
  ];
  const insightRows = [
    {
      label: "Most used model",
      value: topModel?.model ?? "No model activity",
    },
    { label: "Successful requests", value: formatPercent(successRate) },
    { label: "Active days", value: formatInteger(totals?.activeDays ?? 0) },
    { label: "Total requests", value: formatInteger(totals?.requests ?? 0) },
    {
      label: "Completion share",
      value: completionShare === null ? "Not reported" : formatPercent(completionShare),
    },
  ];

  return (
    <div className="usage-activity-overview">
      <header className="usage-profile-header">
        <div className="usage-profile-avatar" aria-hidden="true">
          {identity.image ? <img src={identity.image} alt="" /> : <span>{identity.initial}</span>}
        </div>
        <div className="usage-profile-copy">
          <h1>{identity.name}</h1>
          <div className="usage-profile-meta">
            <span>{identity.handle}</span>
            {identity.badge ? <span className="usage-profile-badge">{identity.badge}</span> : null}
          </div>
        </div>
      </header>

      <div className="usage-hero-metrics" aria-label="Activity summary">
        {metrics.map((metric) => (
          <div className="usage-hero-metric" key={metric.label}>
            <strong>{metric.value}</strong>
            <span>{metric.label}</span>
          </div>
        ))}
      </div>

      <section className="usage-activity-section" aria-labelledby="usage-activity-title">
        <div className="usage-section-heading">
          <div>
            <h2 id="usage-activity-title">Token activity</h2>
            <span>{activityRangeLabel(summary, range)}</span>
          </div>
          <div className="usage-activity-mode" role="group" aria-label="Activity display">
            {(["daily", "weekly", "cumulative"] as const).map((mode) => (
              <button
                type="button"
                className={activityMode === mode ? "active" : ""}
                key={mode}
                onClick={() => setActivityMode(mode)}
              >
                {titleCase(mode)}
              </button>
            ))}
          </div>
        </div>
        {loading && !summary ? (
          <div className="usage-activity-loading">
            <Loader2 className="settings-spin" size={16} />
            <span>Loading activity</span>
          </div>
        ) : (
          <ActivityVisualization
            calendar={calendar}
            colorByModel={colorByModel}
            mode={activityMode}
            modelColors={modelColors}
          />
        )}
      </section>

      <div className="usage-insight-grid">
        <section className="usage-insight-section" aria-labelledby="usage-insights-title">
          <h2 id="usage-insights-title">Activity insights</h2>
          <div className="usage-insight-list">
            {insightRows.map((row) => (
              <div className="usage-insight-row" key={row.label}>
                <span>{row.label}</span>
                <strong title={row.value}>{row.value}</strong>
              </div>
            ))}
          </div>
        </section>
        <ModelMix
          colorByModel={colorByModel}
          rows={summary?.models ?? []}
          totalTokens={totals?.totalTokens ?? 0}
        />
      </div>
    </div>
  );
}

function usageModelKey(provider: string, model: string): string {
  return JSON.stringify([provider, model]);
}

function ActivityVisualization({
  calendar,
  colorByModel,
  mode,
  modelColors,
}: {
  calendar: ActivityWeek[];
  colorByModel: Map<string, string>;
  mode: ActivityMode;
  modelColors: ModelColor[];
}) {
  const [hoveredDay, setHoveredDay] = useState<HoveredActivityDay | null>(null);
  const monthLabels = calendar.map((week, index) => {
    const date = localDateFromKey(week.firstDate);
    const previous = index > 0 ? localDateFromKey(calendar[index - 1]!.firstDate) : null;
    const show = !previous || previous.getMonth() !== date.getMonth();
    return show ? monthFormatter.format(date) : "";
  });

  return (
    <div className="usage-activity-visualization">
      {mode === "daily" && hoveredDay && !hoveredDay.day.future ? (
        <ActivityDayTooltip
          colorByModel={colorByModel}
          day={hoveredDay.day}
          left={hoveredDay.left}
          top={hoveredDay.top}
        />
      ) : null}
      <div className="usage-activity-scroll">
        <div className="usage-activity-canvas">
          {mode === "daily" ? (
            <div className="usage-heatmap" role="grid" aria-label="Daily token activity for the last year">
              {calendar.flatMap((week) =>
                week.days.map((day) => {
                  const gradient = dayModelGradient(day.models, colorByModel);
                  return (
                    <span
                      aria-label={activityDayLabel(day)}
                      className={`usage-activity-cell ${day.future ? "future" : ""} ${day.totalTokens > 0 ? "has-activity" : ""}`}
                      data-level={activityLevel(day.totalTokens, calendar)}
                      data-model-count={day.models.length}
                      key={day.date}
                      onBlur={() => setHoveredDay(null)}
                      onFocus={(event) => {
                        const next = activityTooltipPosition(day, event.currentTarget);
                        if (next) setHoveredDay(next);
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        const next = activityTooltipPosition(day, event.currentTarget);
                        if (next) setHoveredDay(next);
                      }}
                      onMouseEnter={(event) => {
                        const next = activityTooltipPosition(day, event.currentTarget);
                        if (next) setHoveredDay(next);
                      }}
                      onMouseLeave={() => setHoveredDay(null)}
                      role="gridcell"
                      style={gradient ? { "--usage-cell-gradient": gradient } as CSSProperties : undefined}
                      tabIndex={day.future ? undefined : -1}
                    />
                  );
                }),
              )}
            </div>
          ) : (
            <ActivityBars calendar={calendar} cumulative={mode === "cumulative"} />
          )}
          <div className="usage-activity-months" aria-hidden="true">
            {monthLabels.map((label, index) => (
              <span key={`${calendar[index]!.firstDate}:${label}`}>{label}</span>
            ))}
          </div>
        </div>
      </div>
      {modelColors.length ? <ModelLegend models={modelColors} /> : null}
    </div>
  );
}

function ActivityDayTooltip({
  colorByModel,
  day,
  left,
  top,
}: {
  colorByModel: Map<string, string>;
  day: ActivityDay;
  left: number;
  top: number;
}) {
  return (
    <div
      className="usage-day-tooltip"
      role="status"
      style={{ "--usage-tooltip-left": `${left}px`, "--usage-tooltip-top": `${top}px` } as CSSProperties}
    >
      <strong>{longDateFormatter.format(localDateFromKey(day.date))}</strong>
      <span>
        {day.totalTokens > 0
          ? `${formatTokens(day.totalTokens)} tokens · ${formatInteger(day.requests)} ${day.requests === 1 ? "request" : "requests"}`
          : "No recorded usage"}
      </span>
      {day.models.length ? (
        <div className="usage-day-tooltip-models">
          {day.models.map((model) => (
            <div key={usageModelKey(model.provider, model.model)}>
              <i
                aria-hidden="true"
                style={{
                  background: colorByModel.get(usageModelKey(model.provider, model.model)),
                  color: colorByModel.get(usageModelKey(model.provider, model.model)),
                }}
              />
              <small title={`${providerLabel(model.provider)} · ${model.model}`}>{model.model}</small>
              <em>{formatTokens(model.totalTokens)}</em>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ModelLegend({ models }: { models: ModelColor[] }) {
  return (
    <div className="usage-model-legend" aria-label="Model colors">
      {models.map((model) => (
        <span key={model.key} title={`${providerLabel(model.provider)} · ${model.model}`}>
          <i aria-hidden="true" style={{ background: model.color }} />
          {model.model}
        </span>
      ))}
    </div>
  );
}

function ActivityBars({
  calendar,
  cumulative,
}: {
  calendar: ActivityWeek[];
  cumulative: boolean;
}) {
  let runningTotal = 0;
  const values = calendar.map((week) => {
    runningTotal += week.totalTokens;
    return cumulative ? runningTotal : week.totalTokens;
  });
  const maximum = Math.max(1, ...values);
  return (
    <div
      className={`usage-activity-bars ${cumulative ? "cumulative" : ""}`}
      role="img"
      aria-label={cumulative ? "Cumulative token activity by week" : "Weekly token activity"}
    >
      {values.map((value, index) => (
        <span
          aria-hidden="true"
          key={calendar[index]!.firstDate}
          style={{ height: `${Math.max(value > 0 ? 5 : 2, (value / maximum) * 100)}%` }}
          title={`${weekLabel(calendar[index]!)}: ${formatTokens(value)}${cumulative ? " cumulative" : ""}`}
        />
      ))}
    </div>
  );
}

function ModelMix({
  colorByModel,
  rows,
  totalTokens,
}: {
  colorByModel: Map<string, string>;
  rows: UsageModelBreakdown[];
  totalTokens: number;
}) {
  const models = aggregateModelRows(rows);
  return (
    <section className="usage-insight-section" aria-labelledby="usage-model-mix-title">
      <h2 id="usage-model-mix-title">Model activity</h2>
      {models.length ? (
        <div className="usage-model-mix">
          {models.map((model) => {
            const share = (model.totalTokens ?? 0) / Math.max(1, totalTokens);
            const color = colorByModel.get(usageModelKey(model.provider, model.model)) ?? modelColorAt(0);
            return (
              <div className="usage-model-mix-row" key={usageModelKey(model.provider, model.model)}>
                <div
                  className="usage-model-mix-icon"
                  aria-hidden="true"
                  style={{ background: color }}
                />
                <div className="usage-model-mix-copy">
                  <strong title={model.model}>{model.model}</strong>
                  <span>{providerLabel(model.provider)} · {formatInteger(model.requests)} requests</span>
                  <i
                    style={{
                      "--usage-model-color": color,
                      "--usage-model-share": `${Math.min(100, share * 100)}%`,
                    } as CSSProperties}
                  />
                </div>
                <span>{formatTokens(model.totalTokens)}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="usage-model-mix-empty">
          <Activity size={16} />
          <span>No model activity yet</span>
        </div>
      )}
    </section>
  );
}

function buildActivityCalendar(daily: UsageDailyBucket[], rangeEnd?: string): ActivityWeek[] {
  const endSource = rangeEnd ? new Date(rangeEnd) : new Date();
  const today = Number.isNaN(endSource.getTime()) ? new Date() : endSource;
  const finalSaturday = addDays(startOfDay(today), 6 - today.getDay());
  const firstSunday = addDays(finalSaturday, -(53 * 7 - 1));
  const bucketByDate = new Map(daily.map((bucket) => [bucket.date, bucket]));
  const weeks: ActivityWeek[] = [];
  for (let weekIndex = 0; weekIndex < 53; weekIndex += 1) {
    const days: ActivityDay[] = [];
    for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
      const date = addDays(firstSunday, weekIndex * 7 + dayIndex);
      const key = localDateKey(date);
      const bucket = bucketByDate.get(key);
      days.push({
        date: key,
        future: date > today,
        models: bucket?.models ?? [],
        requests: bucket?.requests ?? 0,
        totalTokens: bucket?.totalTokens ?? 0,
      });
    }
    weeks.push({
      days,
      firstDate: days[0]!.date,
      totalTokens: days.reduce((total, day) => total + day.totalTokens, 0),
    });
  }
  return weeks;
}

function activityLevel(value: number, calendar: ActivityWeek[]): number {
  if (value <= 0) return 0;
  const values = calendar.flatMap((week) => week.days.map((day) => day.totalTokens)).filter((item) => item > 0);
  const maximum = Math.max(1, ...values);
  const ratio = value / maximum;
  if (ratio >= 0.75) return 5;
  if (ratio >= 0.5) return 4;
  if (ratio >= 0.25) return 3;
  if (ratio >= 0.1) return 2;
  return 1;
}

function activityDayLabel(day: ActivityDay): string {
  const date = localDateFromKey(day.date);
  if (day.future) return longDateFormatter.format(date);
  return `${longDateFormatter.format(date)}: ${formatTokens(day.totalTokens)} tokens across ${formatInteger(day.requests)} requests`;
}

function activityTooltipPosition(
  day: ActivityDay,
  cell: HTMLElement,
): HoveredActivityDay | null {
  const container = cell.closest<HTMLDivElement>(".usage-activity-visualization");
  if (!container) return null;
  const cellRect = cell.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const tooltipHalfWidth = Math.min(125, Math.max(80, containerRect.width / 2));
  const centeredLeft = cellRect.left - containerRect.left + cellRect.width / 2;
  return {
    day,
    left: Math.min(
      Math.max(centeredLeft, tooltipHalfWidth),
      Math.max(tooltipHalfWidth, containerRect.width - tooltipHalfWidth),
    ),
    top: cellRect.top - containerRect.top,
  };
}

function dayModelGradient(models: ActivityDayModel[], colorByModel: Map<string, string>): string | null {
  const activeModels = models
    .filter((model) => model.totalTokens > 0)
    .sort((left, right) => right.totalTokens - left.totalTokens);
  if (!activeModels.length) return null;
  if (activeModels.length === 1) {
    const color = colorByModel.get(usageModelKey(activeModels[0]!.provider, activeModels[0]!.model)) ?? modelColorAt(0);
    return `linear-gradient(135deg, ${color}, ${color})`;
  }
  const totalTokens = activeModels.reduce((total, model) => total + model.totalTokens, 0);
  let progress = 0;
  const stops = activeModels.map((model, index) => {
    const color = colorByModel.get(usageModelKey(model.provider, model.model)) ?? modelColorAt(index);
    const center = progress + (model.totalTokens / Math.max(1, totalTokens)) * 50;
    progress += (model.totalTokens / Math.max(1, totalTokens)) * 100;
    return `${color} ${Math.round(center)}%`;
  });
  return `linear-gradient(135deg, ${stops.join(", ")})`;
}

function buildModelColors(rows: UsageModelBreakdown[], daily: UsageDailyBucket[]): ModelColor[] {
  const models = aggregateModelRows(rows);
  const seen = new Set(models.map((model) => usageModelKey(model.provider, model.model)));
  for (const bucket of daily) {
    for (const model of bucket.models) {
      const key = usageModelKey(model.provider, model.model);
      if (seen.has(key)) continue;
      seen.add(key);
      models.push({
        provider: model.provider,
        model: model.model,
        route: "unknown",
        requests: model.requests,
        promptTokens: null,
        completionTokens: null,
        totalTokens: model.totalTokens,
        averageLatencyMs: null,
        p95LatencyMs: null,
        averageFirstTokenMs: null,
        p95FirstTokenMs: null,
        failures: 0,
        failureRate: 0,
        firstSeenAt: bucket.date,
        lastSeenAt: bucket.date,
      });
    }
  }
  return models.map((model, index) => ({
    color: modelColorAt(index),
    key: usageModelKey(model.provider, model.model),
    model: model.model,
    provider: model.provider,
  }));
}

function modelColorAt(index: number): string {
  if (index < MODEL_COLORS.length) return MODEL_COLORS[index]!;
  const hue = Math.round((205 + (index - MODEL_COLORS.length) * 137.508) % 360);
  return `hsl(${hue} 76% 68%)`;
}

function weekLabel(week: ActivityWeek): string {
  const first = localDateFromKey(week.firstDate);
  const last = addDays(first, 6);
  return `${longDateFormatter.format(first)} – ${longDateFormatter.format(last)}`;
}

function aggregateModelRows(rows: UsageModelBreakdown[]): UsageModelBreakdown[] {
  const models = new Map<string, UsageModelBreakdown>();
  for (const row of rows) {
    const key = usageModelKey(row.provider, row.model);
    const current = models.get(key);
    if (!current) {
      models.set(key, { ...row });
      continue;
    }
    current.requests += row.requests;
    current.promptTokens = addNullable(current.promptTokens, row.promptTokens);
    current.completionTokens = addNullable(current.completionTokens, row.completionTokens);
    current.totalTokens = addNullable(current.totalTokens, row.totalTokens);
    current.failures += row.failures;
    current.failureRate = current.requests > 0 ? current.failures / current.requests : 0;
    current.firstSeenAt = current.firstSeenAt < row.firstSeenAt ? current.firstSeenAt : row.firstSeenAt;
    current.lastSeenAt = current.lastSeenAt > row.lastSeenAt ? current.lastSeenAt : row.lastSeenAt;
  }
  return [...models.values()].sort(
    (left, right) =>
      (right.totalTokens ?? -1) - (left.totalTokens ?? -1) ||
      right.requests - left.requests ||
      left.model.localeCompare(right.model),
  );
}

function usageIdentity(account: AccountState | null) {
  const activeAccount = account?.accounts.find((candidate) => candidate.isActive) ?? null;
  const name = firstText(
    account?.profile?.name,
    activeAccount?.displayLabel,
    account?.label,
    account?.profile?.handle,
    "Your activity",
  )!;
  const rawHandle = firstText(account?.profile?.handle, activeAccount?.handle, account?.activeProfile?.handle);
  const handle = rawHandle ? `@${rawHandle.replace(/^@/, "")}` : "Local OpenPond usage";
  const activeProduct = account?.products.find((product) => product.isActive)?.name ?? null;
  return {
    name,
    handle,
    badge: activeProduct,
    image: firstText(account?.profile?.image, account?.avatarUrl, activeAccount?.avatarUrl),
    initial: name.slice(0, 1).toUpperCase(),
  };
}

function activityRangeLabel(
  summary: UsageSummaryResponse | null,
  range: "7d" | "30d" | "90d" | "all",
): string {
  if (range !== "all") {
    const label = range === "7d" ? "Last 7 days" : range === "30d" ? "Last 30 days" : "Last 90 days";
    return `${label} · days outside this filter stay empty`;
  }
  if (!summary || summary.totals.requests === 0) {
    return "Last 12 months · days without recorded usage stay empty";
  }
  const firstDate = summary.daily[0]?.date;
  const lastDate = summary.daily.at(-1)?.date;
  if (!firstDate || !lastDate) return "Last 12 months";
  const from = longDateFormatter.format(localDateFromKey(firstDate));
  const to = longDateFormatter.format(localDateFromKey(lastDate));
  return firstDate === lastDate
    ? `Last 12 months · stored activity on ${from}`
    : `Last 12 months · stored activity ${from} – ${to}`;
}

function providerLabel(provider: string): string {
  if (provider === "openai") return "OpenAI";
  if (provider === "anthropic") return "Anthropic";
  if (provider === "google") return "Google";
  if (provider === "openpond") return "OpenPond";
  if (provider === "openrouter") return "OpenRouter";
  if (provider === "codex") return "Codex";
  return titleCase(provider.replaceAll("_", " "));
}

function firstText(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function addNullable(left: number | null, right: number | null): number | null {
  if (left === null && right === null) return null;
  return (left ?? 0) + (right ?? 0);
}

function formatTokens(value: number | null): string {
  if (value === null) return "Not reported";
  if (value >= 10_000) return compactNumberFormatter.format(value);
  return integerFormatter.format(value);
}

function formatInteger(value: number): string {
  return integerFormatter.format(value);
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatDays(value: number): string {
  return `${formatInteger(value)} ${value === 1 ? "day" : "days"}`;
}

function formatLongDuration(value: number | null): string {
  if (value === null) return "Not reported";
  const totalSeconds = Math.round(value / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${totalSeconds % 60}s`;
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function localDateKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function localDateFromKey(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year!, month! - 1, day!);
}
