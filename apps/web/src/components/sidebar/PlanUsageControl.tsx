import { useEffect, useId, useRef, useState } from "react";
import type { ChatProvider } from "@openpond/contracts";
import type { ClientConnection } from "../../api/api-client";
import { useProviderPlanUsage } from "../../hooks/useProviderPlanUsage";
import { planUsageIsStale, primaryPlanUsageWindow } from "../../lib/provider-plan-usage";
import { Activity } from "../icons";
import { ProviderPlanUsage } from "../settings/ProviderPlanUsage";
import "../../styles/sidebar/plan-usage-control.css";

export function PlanUsageControl({ connection, provider, accountOpen, onOpen, onOpenProviders }: {
  connection: ClientConnection | null;
  provider: ChatProvider | null;
  accountOpen: boolean;
  onOpen(): void;
  onOpenProviders(): void;
}) {
  const claude = useProviderPlanUsage(connection, "claude-code");
  const codex = useProviderPlanUsage(connection, "codex");
  const activeProvider = provider === "claude-code" || provider === "codex" ? provider : null;
  const query = activeProvider === "claude-code" ? claude : codex;
  const window = activeProvider ? primaryPlanUsageWindow(activeProvider, query.data) : undefined;
  const percent = window ? Math.max(0, Math.min(100, window.remainingPercent)) : null;
  const name = activeProvider === "claude-code" ? "Claude" : "Codex";
  const stale = query.isError || planUsageIsStale(query.data);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const popupId = useId();
  function cancelClose() { if (closeTimer.current !== null) clearTimeout(closeTimer.current); }
  function show() { cancelClose(); onOpen(); setOpen(true); }
  useEffect(() => () => { if (closeTimer.current !== null) clearTimeout(closeTimer.current); }, []);
  useEffect(() => { if (accountOpen) setOpen(false); }, [accountOpen]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);

  const label = activeProvider && percent !== null
    ? `Plan usage: ${name} ${window!.label}, ${Math.floor(percent)}% remaining${stale ? ", last known" : ""}`
    : "Plan usage";
  return <div ref={root} className="plan-usage-control"
    onPointerEnter={event => { if (event.pointerType !== "touch") show(); }}
    onPointerLeave={() => { cancelClose(); closeTimer.current = setTimeout(() => { if (!root.current?.contains(document.activeElement)) setOpen(false); }, 160); }}
    onFocus={show}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}
    onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); trigger.current?.focus(); setOpen(false); } }}>
    <button ref={trigger} type="button" className={`desktop-rail-button plan-usage-trigger${open ? " active" : ""}`}
      aria-label={label} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? popupId : undefined}
      onClick={() => { if (!open) show(); }}>
      {activeProvider ? <span className="plan-usage-ring">
        <svg viewBox="0 0 36 36" aria-hidden="true">
          <circle className="plan-usage-ring-track" cx="18" cy="18" r="15" />
          {percent !== null ? <circle className={`plan-usage-ring-value ${percent < 10 ? "low" : percent < 25 ? "warning" : "healthy"}`}
            cx="18" cy="18" r="15" pathLength="100" strokeDasharray={`${percent} 100`} /> : null}
        </svg>
        <img src={`/agent-sources/${activeProvider}.svg`} alt="" aria-hidden="true" />
      </span> : <Activity size={19} />}
    </button>
    {open ? <div className="plan-usage-popover" id={popupId} role="dialog" aria-label="Plan usage">
      <div className="plan-usage-popover-heading"><strong>Plan usage</strong></div>
      {(["claude-code", "codex"] as const).map(source => <section className="plan-usage-popover-provider" key={source}>
        <div className="plan-usage-popover-provider-heading"><h3><img src={`/agent-sources/${source}.svg`} alt="" />{source === "claude-code" ? "Claude" : "Codex"}</h3></div>
        <ProviderPlanUsage connection={connection} provider={source} sharedOnly />
      </section>)}
      <button type="button" className="plan-usage-manage" onClick={() => { setOpen(false); onOpenProviders(); }}>Manage providers</button>
    </div> : null}
  </div>;
}
