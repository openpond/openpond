import { TaskRatingSchema, type TaskRating } from "openpond-sdk/learning";

export function emptyTaskRating(): TaskRating {
  return { schemaVersion: "openpond.taskRating.v1", criteria: "", scale: { minimum: 1, maximum: 5 }, score: 3, evidence: "", explanation: "" };
}

export function TaskRatingFields({ value, onChange }: { value: TaskRating; onChange: (value: TaskRating) => void }) {
  return <fieldset><legend>Rate this response</legend>
    <label>Criteria<textarea value={value.criteria} placeholder="What makes this response good?" maxLength={20_000} onChange={event => onChange({ ...value, criteria: event.target.value })} /></label>
    <div className="learning-evidence-columns">
      <label>Lowest score<input type="number" step="any" value={Number.isFinite(value.scale.minimum) ? value.scale.minimum : ""} onChange={event => onChange({ ...value, scale: { ...value.scale, minimum: event.target.valueAsNumber } })} /></label>
      <label>Highest score<input type="number" step="any" value={Number.isFinite(value.scale.maximum) ? value.scale.maximum : ""} onChange={event => onChange({ ...value, scale: { ...value.scale, maximum: event.target.valueAsNumber } })} /></label>
      <label>Score<input type="number" min={Number.isFinite(value.scale.minimum) ? value.scale.minimum : undefined} max={Number.isFinite(value.scale.maximum) ? value.scale.maximum : undefined} step="any" value={Number.isFinite(value.score) ? value.score : ""} onChange={event => onChange({ ...value, score: event.target.valueAsNumber })} /></label>
    </div>
    <label>Evidence<textarea value={value.evidence} placeholder="Quote or describe the part of the response supporting your score." maxLength={20_000} onChange={event => onChange({ ...value, evidence: event.target.value })} /></label>
    <label>Explanation<textarea value={value.explanation} placeholder="Explain your judgment." maxLength={20_000} onChange={event => onChange({ ...value, explanation: event.target.value })} /></label>
  </fieldset>;
}

export function TaskRatingDetails({ value }: { value: Record<string, unknown> }) {
  const parsed = TaskRatingSchema.safeParse(value);
  if (!parsed.success) return null;
  const rating = parsed.data;
  return <dl><dt>Criteria</dt><dd>{rating.criteria}</dd><dt>Score</dt><dd>{rating.score} · Scale {rating.scale.minimum}–{rating.scale.maximum}</dd><dt>Evidence</dt><dd>{rating.evidence || "No supporting evidence supplied."}</dd><dt>Explanation</dt><dd>{rating.explanation || "No explanation supplied."}</dd></dl>;
}
