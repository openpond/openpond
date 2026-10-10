import type { PlanUsageProvider, PlanUsageWindow, ProviderPlanUsage as Usage } from "@openpond/contracts";
import type { ClientConnection } from "../../api/api-client";
import { useProviderPlanUsage } from "../../hooks/useProviderPlanUsage";
import { RefreshCw } from "../icons";
import "../../styles/settings/provider-plan-usage.css";

function percent(value: number): string {
  return `${Math.floor(value)}%`;
}

function resetLabel(window: PlanUsageWindow): string {
  return window.resetsAt ? `Resets ${new Date(window.resetsAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : "Reset time unavailable";
}

function statusLabel(usage: Usage | undefined, loading: boolean): string {
  if (loading) return "Loading…";
  if (usage?.status === "signed_out") return "Sign in";
  if (usage?.status === "unsupported") return "Not available";
  return "Unavailable";
}

export function ProviderPlanUsage({ connection, provider, compact = false, onOpen }: {
  connection: ClientConnection | null;
  provider: PlanUsageProvider;
  compact?: boolean;
  onOpen?: () => void;
}) {
  const query = useProviderPlanUsage(connection, provider);
  const usage = query.data;
  const sharedWindows = usage?.windows.filter(window => window.shared) ?? [];
  const expired = Boolean(usage?.windows.some(window => window.resetsAt && Date.parse(window.resetsAt) <= Date.now()));
  const stale = query.isError || expired || Boolean(usage && Date.parse(usage.refreshAfter) + 60_000 < Date.now());
  const name = provider === "claude-code" ? "Claude" : "Codex";
  const available = usage?.status === "ready";
  const label = statusLabel(usage, query.isPending && Boolean(connection));
  const detail = usage?.windows.map(window => `${window.label}: ${percent(window.remainingPercent)} remaining. ${resetLabel(window)}.`).join("\n");

  if (compact) return <button type="button" role="menuitem" className="plan-usage-compact" onClick={onOpen}
    title={stale ? `Usage needs refreshing. ${detail ?? ""}` : detail || usage?.message || "View plan usage in Providers"}>
    <span className="plan-usage-compact-provider"><img src={`/agent-sources/${provider}.svg`} alt="" aria-hidden="true" />{name}</span>
    <span className="plan-usage-compact-values">{!stale && available && sharedWindows.length ? sharedWindows.map(window => <span className="plan-usage-compact-value" key={window.id}><small>{window.label}</small><strong>{percent(window.remainingPercent)}</strong></span>) : <strong>{stale ? "Unavailable" : label}</strong>}</span>
  </button>;

  return <section className="provider-plan-usage" aria-label={`${name} plan usage`}>
    <div className="plan-usage-heading"><button type="button" className="plan-usage-refresh" aria-label={`Refresh ${name} plan usage`} title={`Check usage (cached for up to ${provider === "claude-code" ? "5 minutes" : "1 minute"})`} disabled={!connection || query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={13} className={query.isFetching ? "settings-spin" : undefined} /></button></div>
    {available ? <>
      {usage.windows.map(window => <div className="plan-usage-window" key={window.id}>
        <div><span>{window.label}</span><strong>{percent(window.remainingPercent)}{stale ? " · last known" : ""}</strong></div>
        <meter min={0} max={100} low={10} high={25} optimum={100} value={window.remainingPercent} aria-label={`${name} ${window.label} remaining`} />
        <small>{resetLabel(window)}</small>
      </div>)}
      {stale ? <small role="status">Usage needs refreshing. Last checked {new Date(usage.fetchedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.</small> : <small className="plan-usage-note">Shared across your account. Updates automatically.</small>}
    </> : <p role="status">{query.isError ? "Could not load usage. Try refreshing." : usage?.message ?? (connection ? "Loading plan usage…" : "Connect to load plan usage.")}</p>}
  </section>;
}
