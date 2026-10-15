import { useState } from "react";
import type { TasksetDraft } from "@openpond/contracts";
import { DropdownSelect } from "../DropdownSelect";
import { AppDialog } from "../dialogs/AppDialog";

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
      <div className="taskset-draft-field"><span>Secrets review</span><DropdownSelect floating label="Secrets review" value={source.secretScanStatus}
        options={[{ value: "pending", label: "Pending review" }, { value: "passed", label: "Reviewed: no exposed credentials" }, { value: "blocked", label: "Blocked: credentials found" }]}
        onChange={value => update({ secretScanStatus: value as Source["secretScanStatus"] })} /></div>
      <div className="taskset-draft-field"><span>Privacy review</span><DropdownSelect floating label="Privacy review" value={source.piiScanStatus}
        options={[{ value: "pending", label: "Pending review" }, { value: "passed", label: "Reviewed: privacy requirements satisfied" }, { value: "review", label: "Needs further review" }, { value: "blocked", label: "Blocked" }]}
        onChange={value => update({ piiScanStatus: value as Source["piiScanStatus"] })} /></div>
      <div className="taskset-draft-field"><span>Permission to use this source</span><DropdownSelect floating label="Permission to use this source" value={source.licensingStatus}
        options={[{ value: "pending", label: "Pending review" }, { value: "approved", label: "Reviewed: permitted for this use" }, { value: "review", label: "Needs further review" }, { value: "blocked", label: "Blocked" }]}
        onChange={value => update({ licensingStatus: value as Source["licensingStatus"] })} /></div>
      {"consent" in source && source.consent.status !== "granted" ? <p role="status">This source also needs consent in its original review workflow.</p> : null}
      <details><summary>Source identity</summary><dl><dt>ID</dt><dd>{source.id}</dd><dt>Content hash</dt><dd>{source.sourceHash}</dd></dl></details>
    </section> : null}
    {sources.length > 1 ? <nav className="labs-pagination" aria-label="Source reviews"><button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous source</button><span>{page + 1} of {sources.length}</span><button type="button" disabled={page === sources.length - 1} onClick={() => setPage(page + 1)}>Next source</button></nav> : null}
    <footer className="model-build-actions"><button className="training-button secondary" type="button" onClick={onClose}>Cancel</button><button className="training-button" type="button" onClick={() => { onApply(sources); onClose(); }}>Apply review</button></footer>
  </AppDialog>;
}
