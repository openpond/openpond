import { useEffect, useRef, useState } from "react";
import type { ModelStarter } from "openpond-sdk/model-starters";
import type { ModelStarterPage, ModelStarterPreview, useTraining } from "../../hooks/useTraining";

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
  return <section className="model-starter-catalog" aria-label="Get started">
    <header><h2>Get started</h2><p>Start with published tasks and quality checks, then make the model your own.</p></header>
    {error ? <div role="alert"><p>{error}</p><button type="button" onClick={() => setRefresh(value => value + 1)}>Retry</button></div> : !page ? <p role="status">Loading starters…</p> : null}
    <div className="model-starter-cards">{page?.items.map(starter => <article key={`${starter.id}:${starter.contentHash}`}>
      <span>{starter.category}</span><h3>{starter.name}</h3><p>{starter.description}</p>
      <p>{starter.evidence.evaluation ? "Evaluation results available" : "Training results not yet available"}</p>
      <button type="button" disabled={selectedId !== null} onClick={() => { void select(starter); }}>{selectedId === starter.id ? "Loading…" : "Use starter"}</button>
    </article>)}</div>
    {page && !page.items.length ? <p>No starters have been published yet.</p> : null}
    {afterId || page?.nextCursor ? <nav aria-label="Starter pages"><button type="button" disabled={!afterId || selectedId !== null} onClick={() => setAfterId(undefined)}>First page</button><button type="button" disabled={!page?.nextCursor || selectedId !== null} onClick={() => setAfterId(page?.nextCursor ?? undefined)}>Next page</button></nav> : null}
  </section>;
}
