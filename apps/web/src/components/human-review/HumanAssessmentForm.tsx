import "./human-forms.css";
import type { HumanForm, HumanAnswer } from "@openpond/evals/human-review";
export function NativeHumanAssessmentForm({ form, answers, onChange, disabled = false }: { form: HumanForm; answers: HumanAnswer[]; onChange: (answers: HumanAnswer[]) => void; disabled?: boolean }) {
  function patch(id: string, patch: Partial<HumanAnswer>) {
    const existing = answers.find(a => a.criterionId === id) ?? { criterionId: id, value: null, abstain: false, note: "" };
    onChange([...answers.filter(a => a.criterionId !== id), { ...existing, ...patch }]);
  }
  return <div className="human-assessment-form"><p className="whitespace-pre-wrap text-sm text-muted-foreground">{form.instructions}</p>{form.criteria.map(c => {
    const a = answers.find(answer => answer.criterionId === c.id);
    const controlId = `human-${c.id}`;
    return <fieldset key={c.id} disabled={disabled} className="space-y-2"><legend className="text-sm font-medium">{c.label}{c.required ? " (required)" : ""}</legend><p className="whitespace-pre-wrap text-sm text-muted-foreground">{c.instructions}</p>
      {c.anchors?.length ? <ul className="text-xs text-muted-foreground">{c.anchors.map((anchor, i) => <li key={i}>{String(anchor.value)}: {anchor.description}</li>)}</ul> : null}
      {!a?.abstain ? <>
        {c.kind === "score" ? <><input id={controlId} aria-label={c.label} type="number" className="w-full rounded-md bg-muted p-2" min={c.minimum} max={c.maximum} step={c.step} value={typeof a?.value === "number" ? a.value : ""} onChange={e => { if (e.target.value === "") onChange(answers.filter(a => a.criterionId !== c.id)); else patch(c.id, { value: Number(e.target.value), abstain: false }); }} /><p className="text-xs text-muted-foreground">Raw scale {c.minimum} to {c.maximum}, step {c.step}</p></> : null}
        {c.kind === "boolean" || c.kind === "category" || c.kind === "preference" ? <select id={controlId} aria-label={c.label} className="w-full rounded-md bg-muted p-2" value={a?.value === null || a?.value === undefined ? "" : String(a.value)} onChange={e => { if (!e.target.value) onChange(answers.filter(a => a.criterionId !== c.id)); else patch(c.id, { value: c.kind === "boolean" ? e.target.value === "true" : e.target.value, abstain: false }); }}><option value="">Select an answer</option>{(c.kind === "boolean" ? ["true", "false"] : c.kind === "category" ? c.options : ["A", "B", ...(c.allowTie ? ["tie"] : [])]).map(v => <option key={v} value={v}>{c.kind === "boolean" ? v === "true" ? "Yes" : "No" : v}</option>)}</select> : null}
        {c.kind === "text" ? <textarea id={controlId} aria-label={c.label} className="w-full rounded-md bg-muted p-2" minLength={c.minimumLength} maxLength={c.maximumLength} value={typeof a?.value === "string" ? a.value : ""} onChange={e => patch(c.id, { value: e.target.value, abstain: false })} /> : null}
        {c.kind === "preference" && c.requireStrength ? <label className="block text-sm">Preference strength<select className="ml-2 rounded-md bg-muted p-2" value={a?.strength ?? ""} onChange={e => patch(c.id, { strength: e.target.value as HumanAnswer["strength"] })}><option value="">Select strength</option><option value="slight">Slight</option><option value="moderate">Moderate</option><option value="strong">Strong</option></select></label> : null}
      </> : null}
      {c.allowAbstain ? <label className="flex gap-2 text-sm"><input type="checkbox" checked={a?.abstain ?? false} onChange={e => { if (e.target.checked) patch(c.id, { abstain: true, value: null }); else onChange(answers.filter(a => a.criterionId !== c.id)); }} />Unable to judge this criterion</label> : null}
      <label className="block text-sm">{a?.abstain ? "Reason for abstaining" : c.requireRationale ? "Rationale (required)" : "Rationale"}<textarea className="mt-1 w-full rounded-md bg-muted p-2" maxLength={20000} value={a?.note ?? ""} onChange={e => patch(c.id, { note: e.target.value })} /></label>
    </fieldset>;
  })}</div>;
}
