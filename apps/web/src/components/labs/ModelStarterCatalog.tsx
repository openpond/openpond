import { useEffect, useRef, useState } from "react";
import type { ModelStarter } from "openpond-sdk/model-starters";
import type { ModelStarterPage, ModelStarterPreview, useTraining } from "../../hooks/useTraining";

const CATEGORY_LABELS: Record<ModelStarter["category"], string> = { extraction: "Extract structured data", support: "Customer support", operations: "Operations", knowledge: "Knowledge", coding: "Code", writing: "Writing", classification: "Classification" };

export function ModelStarterCatalog({ actions, onSelect }: { actions: ReturnType<typeof useTraining>["actions"]; onSelect: (preview: ModelStarterPreview) => void }) {
  const [afterId, setAfterId] = useState<string | undefined>();
  const [page, setPage] = useState<ModelStarterPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const selection = useRef(0);
  const { listModelStarters, previewModelStarter } = actions;
  useEffect(() => {
    let cancelled = false;
    setPage(null);
    setError(null);
    void listModelStarters(afterId).then(result => { if (!cancelled) setPage(result); }).catch((caught: unknown) => { if (!cancelled) setError(caught instanceof Error ? caught.message : "Unable to load starters."); });
    return () => { cancelled = true; selection.current += 1; };
  }, [afterId, listModelStarters, refresh]);
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
    {error ? <div role="alert"><p>{error}</p><button type="button" onClick={() => setRefresh(value => value + 1)}>Retry</button></div> : !page ? <p role="status">Loading starters…</p> : null}
    {categories.map(category => <section className="model-starter-category" key={category} aria-label={CATEGORY_LABELS[category]}>
      <h3>{CATEGORY_LABELS[category]}</h3>
      <div className="model-starter-cards">{page?.items.filter(starter => starter.category === category).map(starter => <article key={`${starter.id}:${starter.contentHash}`}>
        <div className="model-starter-title"><h4>{starter.name}</h4><span className="model-starter-reward-badge">{starter.rewards.length} {starter.rewards.length === 1 ? "Reward" : "Rewards"}</span></div>
        <div className="model-starter-description"><p>{starter.description}</p><button className="training-button secondary" type="button" aria-label={`Create ${starter.name}`} disabled={selectedId !== null} onClick={() => { void select(starter); }}>{selectedId === starter.id ? "Loading…" : "Create"}</button></div>
        <p>{starter.evidence.evaluation ? "Evaluation results available" : "Learning qualification pending"}</p>
      </article>)}</div>
    </section>)}
    {page && !page.items.length ? <p>No starters have been published yet.</p> : null}
    {afterId || page?.nextCursor ? <nav aria-label="Starter pages"><button type="button" disabled={!afterId || selectedId !== null} onClick={() => setAfterId(undefined)}>First page</button><button type="button" disabled={!page?.nextCursor || selectedId !== null} onClick={() => setAfterId(page?.nextCursor ?? undefined)}>Next page</button></nav> : null}
  </section>;
}
