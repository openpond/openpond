import type { ReactNode } from "react";
import { LearningJsonObjectSchema } from "openpond-sdk/learning";
import { assertBoundedTaskJson } from "@openpond/evals/task-schema";

export function parseLearningObject(text: string) {
  const value: unknown = JSON.parse(text);
  assertBoundedTaskJson(value);
  return LearningJsonObjectSchema.parse(value);
}
export function LearningJsonField({ label, value, onChange, hint, disabled = false }: { label: string; value: string; onChange: (value: string) => void; hint?: string; disabled?: boolean }) {
  return <label className="learning-json-field"><span>{label}</span>{hint ? <small>{hint}</small> : null}<textarea spellCheck={false} rows={8} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} /></label>;
}
export function LearningError({ error }: { error: string | null }) { return error ? <p role="alert" className="training-error">{error}</p> : null; }
export function LearningPager({ after, next, onPage }: { after?: string | null; next?: string | null; onPage: (cursor: string | null) => void }) {
  return after || next ? <div className="model-build-actions">{after ? <button type="button" className="training-button secondary" onClick={() => onPage(null)}>First page</button> : null}{next ? <button type="button" className="training-button secondary" onClick={() => onPage(next)}>Next page</button> : null}</div> : null;
}
export function LearningValue({ label, value }: { label: string; value: unknown }) { return <div className="learning-value"><h3>{label}</h3><pre>{JSON.stringify(value, null, 2) ?? "Not provided"}</pre></div>; }
export function LearningActions({ children }: { children: ReactNode }) { return <div className="model-build-actions">{children}</div>; }
