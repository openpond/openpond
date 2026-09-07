import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelStarter } from "openpond-sdk/model-starters";
import type { ModelStarterPage, ModelStarterPreview, useTraining } from "../../hooks/useTraining";
import { readModelStarterCache, writeModelStarterCache } from "./model-starter-cache";

const CATEGORY_LABELS: Record<ModelStarter["category"], string> = { extraction: "Extract structured data", support: "Customer support", operations: "Operations", knowledge: "Knowledge", coding: "Code", writing: "Writing", classification: "Classification" };

export function ModelStarterCatalog({ actions, cacheScope, onSelect }: { actions: ReturnType<typeof useTraining>["actions"]; cacheScope: string | null; onSelect: (preview: ModelStarterPreview) => void }) {
  const [afterId, setAfterId] = useState<string | undefined>();
  const [loaded, setLoaded] = useState<{ scope: string | null; afterId: string | undefined; page: ModelStarterPage } | null>(null);
  const cached = useMemo(() => {
    try { return cacheScope ? readModelStarterCache(window.localStorage, cacheScope, afterId) : null; }
    catch { return null; }
  }, [cacheScope, afterId]);
  const page = loaded?.scope === cacheScope && loaded.afterId === afterId ? loaded.page : cached;
  const [refreshing, setRefreshing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const selection = useRef(0);
  const { listModelStarters, previewModelStarter } = actions;
  useEffect(() => {
    let cancelled = false;
    let freshReceived = false;
    setRefreshing(true);
    setError(null);
    function receive(result: ModelStarterPage) {
      if (cancelled) return;
      try { if (cacheScope) writeModelStarterCache(window.localStorage, cacheScope, afterId, result); } catch { /* Browser storage may be disabled. */ }
      setLoaded({ scope: cacheScope, afterId, page: result });
    }
    // The local runtime's durable cache survives a new packaged renderer origin.
    // A late cached response must never overwrite the background refresh.
    void listModelStarters(afterId).then(result => { if (!freshReceived) receive(result); }).catch(() => { /* The fresh request reports the current error below. */ });
    void listModelStarters(afterId, true).then(result => { freshReceived = true; receive(result); })
      .catch((caught: unknown) => { if (!cancelled) setError(caught instanceof Error ? caught.message : "Unable to load starters."); })
      .finally(() => { if (!cancelled) setRefreshing(false); });
    return () => { cancelled = true; selection.current += 1; };
  }, [cacheScope, afterId, listModelStarters, refresh]);
  async function select(starter: ModelStarter) {
    const current = ++selection.current;
    setSelectedId(starter.id);
    setError(null);
    try {
      const preview = await previewModelStarter(starter);
      if (current === selection.current) onSelect(preview);
    } catch (caught) {
      if (current === selection.current) setError(caught instanceof Error ? caught.message : "Unable to preview this starter.");
    } finally { if (current === selection.current) setSelectedId(null); }
  }
  const categories = [...new Set(page?.items.map(starter => starter.category) ?? [])];
  return <section className="model-starter-catalog" aria-label="Get started">
    <header><h2>Get started</h2><p>Start with published tasks and quality checks, then make the model your own.</p></header>
    {error ? <div role="alert"><p>{page ? `Showing saved starters. ${error}` : error}</p><button type="button" onClick={() => setRefresh(value => value + 1)}>Retry</button></div> : !page ? <p role="status">Loading starters…</p> : refreshing ? <p role="status">Refreshing starters…</p> : null}
    {categories.map(category => <section className="model-starter-category" key={category} aria-label={CATEGORY_LABELS[category]}>
      <h3>{CATEGORY_LABELS[category]}</h3>
      <div className="model-starter-cards">{page?.items.filter(starter => starter.category === category).map(starter => <article key={`${starter.id}:${starter.contentHash}`}>
        <div className="model-starter-title"><h4>{starter.name}</h4>{starter.rewardSummary?.length ? <span className="model-starter-reward-badge" title={starter.rewardSummary.map(reward => reward.name).join(", ")}>{[...new Set(starter.rewardSummary.map(reward => reward.kind === "custom_verifier" ? "Code verifier" : reward.kind === "model_judge" ? "LLM judge" : reward.kind === "human" ? "Human review" : reward.kind === "learned_model" ? "Reward model" : "Deterministic check"))].join(" · ")}</span> : null}</div>
        <div className="model-starter-description"><p>{starter.description}</p><button className="training-button secondary" type="button" aria-label={`Create ${starter.name}`} disabled={selectedId !== null} onClick={() => { void select(starter); }}>{selectedId === starter.id ? "Loading…" : "Create"}</button></div>
      </article>)}</div>
    </section>)}
    {page && !page.items.length ? <p>No starters have been published yet.</p> : null}
    {afterId || page?.nextCursor ? <nav aria-label="Starter pages"><button type="button" disabled={!afterId || selectedId !== null} onClick={() => setAfterId(undefined)}>First page</button><button type="button" disabled={!page?.nextCursor || selectedId !== null} onClick={() => setAfterId(page?.nextCursor ?? undefined)}>Next page</button></nav> : null}
  </section>;
}
