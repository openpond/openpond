import type { PlanUsageProvider, PlanUsageWindow } from "@openpond/contracts";
import type { ClientConnection } from "../../api/api-client";
import { useProviderPlanUsage } from "../../hooks/useProviderPlanUsage";
import { RefreshCw } from "../icons";
import { useErrorToast } from "../../app/AppToastContext";
import { planUsageIsStale } from "../../lib/provider-plan-usage";
import "../../styles/settings/provider-plan-usage.css";

function percent(value: number): string {
  return `${Math.floor(value)}%`;
}

function resetLabel(window: PlanUsageWindow): string {
  return window.resetsAt ? `Resets ${new Date(window.resetsAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : "Reset time unavailable";
}

export function ProviderPlanUsageRefresh({ connection, provider }: {
  connection: ClientConnection | null;
  provider: PlanUsageProvider;
}) {
  const query = useProviderPlanUsage(connection, provider, { poll: false });
  const name = provider === "claude-code" ? "Claude" : "Codex";
  return <button type="button" className="plan-usage-refresh" aria-label={`Refresh ${name} plan usage`}
    title={`Check usage (cached for up to ${provider === "claude-code" ? "5 minutes" : "1 minute"})`}
    disabled={!connection || query.isFetching} onClick={() => void query.refetch()}>
    <RefreshCw size={13} className={query.isFetching ? "settings-spin" : undefined} />
  </button>;
}

export function ProviderPlanUsage({ connection, provider, sharedOnly = false }: {
  connection: ClientConnection | null;
  provider: PlanUsageProvider;
  sharedOnly?: boolean;
}) {
  const query = useProviderPlanUsage(connection, provider);
  const usage = query.data;
  const sharedWindows = usage?.windows.filter(window => window.shared) ?? [];
  const stale = query.isError || planUsageIsStale(usage);
  const name = provider === "claude-code" ? "Claude" : "Codex";
  const available = usage?.status === "ready";
  useErrorToast(query.error ?? (usage?.status === "unavailable" || available ? usage?.message : null), { prefix: `${name} usage` });

  return <section className="provider-plan-usage" aria-label={`${name} plan usage`} aria-busy={query.isFetching}>
    {available ? <>
      {(sharedOnly ? sharedWindows : usage.windows).map(window => <div className="plan-usage-window" key={window.id}>
        <div><span>{window.label}</span><strong>{percent(window.remainingPercent)}{stale ? " · last known" : ""}</strong></div>
        <meter min={0} max={100} low={10} high={25} optimum={100} value={window.remainingPercent} aria-label={`${name} ${window.label} remaining`} />
        <small>{resetLabel(window)}</small>
      </div>)}
      {stale ? <small>Last checked {new Date(usage.fetchedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}.</small> : null}
    </> : <p role="status">{usage?.status === "signed_out" || usage?.status === "unsupported" ? usage.message : query.isPending ? (connection ? "Loading plan usage…" : "Connect to load plan usage.") : "No usage reading yet."}</p>}
  </section>;
}
