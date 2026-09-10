import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ModelProjectPageHeader } from "./ModelProjectPageHeader";
import type { ModelStarter } from "openpond-sdk/model-starters";
import type { ModelStarterPreview, useTraining } from "../../hooks/useTraining";
import { readModelStarterCache, writeModelStarterCache } from "./model-starter-cache";

const CATEGORY_LABELS: Record<ModelStarter["category"], string> = { extraction: "Extract structured data", support: "Customer support", operations: "Operations", knowledge: "Knowledge", coding: "Code", writing: "Writing", classification: "Classification" };

export function ModelStarterCatalog({ actions, cacheScope, onSelect, onImport, onCreate }: {
  actions: ReturnType<typeof useTraining>["actions"]; cacheScope: string | null; onSelect: (preview: ModelStarterPreview) => void;
  onImport: (source: "hermes" | "openclaw") => void; onCreate: () => void;
}) {
  const [afterId, setAfterId] = useState<string | undefined>();
  const queries = useQueryClient();
  const cached = useMemo(() => {
    try { return cacheScope ? readModelStarterCache(window.localStorage, cacheScope, afterId) : null; }
    catch { return null; }
  }, [cacheScope, afterId]);
  const { listModelStarters, previewModelStarter } = actions;
  const catalog = useQuery({ queryKey: ["model-starters", cacheScope, afterId ?? null], enabled: Boolean(cacheScope),
    initialData: cached ?? undefined, initialDataUpdatedAt: 0, queryFn: async () => {
      const page = await listModelStarters(afterId, true);
      try { if (cacheScope) writeModelStarterCache(window.localStorage, cacheScope, afterId, page); } catch { /* Browser storage may be disabled. */ }
      return page;
    } });
  const page = catalog.data ?? null;
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selection = useRef(0);
  useEffect(() => () => { selection.current += 1; }, [cacheScope]);
  async function select(starter: ModelStarter) {
    const current = ++selection.current;
    setSelectedId(starter.id);
    setError(null);
    try {
      const preview = await queries.fetchQuery({ queryKey: ["model-starter-preview", cacheScope, starter.id, starter.revision, starter.contentHash], queryFn: () => previewModelStarter(starter), staleTime: Infinity });
      if (current === selection.current) onSelect(preview);
    } catch (caught) {
      if (current === selection.current) setError(caught instanceof Error ? caught.message : "Unable to preview this starter.");
    } finally { if (current === selection.current) setSelectedId(null); }
  }
  const categories = [...new Set(page?.items.map(starter => starter.category) ?? [])];
  return <section className="model-starter-catalog" aria-label="Get started">
    <ModelProjectPageHeader title="Get started" description="" />
    <div className="model-starter-cards model-starter-intake">
      <article><h3>Create your own</h3><p>Choose or create tasks and a Reward for the model you want to train.</p><button className="training-button" type="button" disabled={selectedId !== null} onClick={onCreate}>Create model</button></article>
      <article><h3>Import from Hermes</h3><p>Review sessions and turn useful attempts into tasks and feedback.</p><button className="training-button secondary" type="button" disabled={selectedId !== null} onClick={() => onImport("hermes")}>Import sessions</button></article>
      <article><h3>Import from OpenClaw</h3><p>Bring trajectory exports into the same task and labeling workspace.</p><button className="training-button secondary" type="button" disabled={selectedId !== null} onClick={() => onImport("openclaw")}>Import trajectories</button></article>
    </div>
    {error || catalog.error ? <div role="alert"><p>{error ?? catalog.error?.message}</p><button type="button" onClick={() => { setError(null); void catalog.refetch(); }}>Retry</button></div> : !page && catalog.isPending ? <p role="status">Loading starters…</p> : null}
    {categories.map(category => <section className="model-starter-category" key={category} aria-label={CATEGORY_LABELS[category]}>
      <h3>{CATEGORY_LABELS[category]}</h3>
      <div className="model-starter-cards">{page?.items.filter(starter => starter.category === category).map(starter => <article key={`${starter.id}:${starter.contentHash}`}>
        <div className="model-starter-title"><h4>{starter.name}</h4>{starter.rewardSummary?.length ? <span className="model-starter-reward-badge" title={starter.rewardSummary.map(reward => reward.name).join(", ")}>{[...new Set(starter.rewardSummary.map(reward => reward.kind === "custom_verifier" ? "Code verifier" : reward.kind === "model_judge" ? "LLM judge" : reward.kind === "human" ? "Human review" : reward.kind === "learned_model" ? "Reward model" : "Deterministic check"))].join(" · ")}</span> : null}</div>
        <div className="model-starter-description"><p>{starter.description}</p><button className="training-button secondary" type="button" aria-label={`Create ${starter.name}`} disabled={selectedId !== null} onClick={() => { void select(starter); }}>{selectedId === starter.id ? "Loading…" : "Create"}</button></div>
      </article>)}</div>
    </section>)}
    {afterId || page?.nextCursor ? <nav aria-label="Starter pages"><button type="button" disabled={!afterId || selectedId !== null} onClick={() => setAfterId(undefined)}>First page</button><button type="button" disabled={!page?.nextCursor || selectedId !== null} onClick={() => setAfterId(page?.nextCursor ?? undefined)}>Next page</button></nav> : null}
  </section>;
}
