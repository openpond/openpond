import { useState } from "react";
import type { TasksetDraft } from "@openpond/contracts";
import { AppDialog } from "../dialogs/AppDialog";
import { Field } from "./TasksetDraftEditorPrimitives";

type Source = TasksetDraft["sourceRefs"][number];

export function TaskDraftSourceReview({ draft, onApply, onClose }: {
  draft: TasksetDraft; onApply: (sources: Source[]) => void; onClose: () => void;
}) {
  const [sources, setSources] = useState(draft.sourceRefs);
  const [page, setPage] = useState(0);
  const source = sources[page];
  function update(patch: Partial<Pick<Source, "secretScanStatus" | "piiScanStatus" | "licensingStatus">>) {
    setSources(current => current.map((value, index) => index === page ? { ...value, ...patch } : value));
  }
  return <AppDialog ariaLabel="Source review" className="labs-rename-dialog labs-model-create-dialog" backdropClassName="labs-rename-backdrop" onClose={onClose}>
    <header><div><h2>Source review</h2><p>Record your review of the source materials before publishing. Unresolved checks must stay pending; this form does not run an automated scan.</p></div></header>
    {source ? <section className="taskset-draft-fields">
      <h3>{source.title}</h3>
      <p>{draft.tasks.filter(task => task.sourceRefs.includes(source.id)).length} tasks use this source. Review their inputs, context, private references and attached files.</p>
      {"originalFileNames" in source ? <p>{source.originalFileNames.join(", ")}</p> : null}
      <Field label="Secrets review"><select aria-label="Secrets review" value={source.secretScanStatus} onChange={event => update({ secretScanStatus: event.target.value as Source["secretScanStatus"] })}>
        <option value="pending">Pending review</option><option value="passed">Reviewed: no exposed credentials</option><option value="blocked">Blocked: credentials found</option>
      </select></Field>
      <Field label="Privacy review"><select aria-label="Privacy review" value={source.piiScanStatus} onChange={event => update({ piiScanStatus: event.target.value as Source["piiScanStatus"] })}>
        <option value="pending">Pending review</option><option value="passed">Reviewed: privacy requirements satisfied</option><option value="review">Needs further review</option><option value="blocked">Blocked</option>
      </select></Field>
      <Field label="Permission to use this source"><select aria-label="Permission to use this source" value={source.licensingStatus} onChange={event => update({ licensingStatus: event.target.value as Source["licensingStatus"] })}>
        <option value="pending">Pending review</option><option value="approved">Reviewed: permitted for this use</option><option value="review">Needs further review</option><option value="blocked">Blocked</option>
      </select></Field>
      {"consent" in source && source.consent.status !== "granted" ? <p role="status">This source also needs consent in its original review workflow.</p> : null}
      <details><summary>Source identity</summary><dl><dt>ID</dt><dd>{source.id}</dd><dt>Content hash</dt><dd>{source.sourceHash}</dd></dl></details>
    </section> : null}
    {sources.length > 1 ? <nav className="labs-pagination" aria-label="Source reviews"><button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous source</button><span>{page + 1} of {sources.length}</span><button type="button" disabled={page === sources.length - 1} onClick={() => setPage(page + 1)}>Next source</button></nav> : null}
    <footer className="model-build-actions"><button className="training-button secondary" type="button" onClick={onClose}>Cancel</button><button className="training-button" type="button" onClick={() => { onApply(sources); onClose(); }}>Apply review</button></footer>
  </AppDialog>;
}
