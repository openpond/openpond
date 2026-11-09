import { DecisionQuestionFormDraftSchema, type DecisionExperimentFormDraft } from "openpond-sdk/training";
import type { z } from "zod";
type DecisionQuestionFormDraft = z.infer<typeof DecisionQuestionFormDraftSchema>;
import { DropdownSelect } from "../../DropdownSelect";

type Score = Extract<DecisionExperimentFormDraft, {mode: "score"}>;
export function DecisionScoringFields({form, onChange, compact = false}: {form: Score; onChange: (form: Score) => void; compact?: boolean}) {
  const patchQuestion = (index: number, next: DecisionQuestionFormDraft) => onChange({...form, questions: form.questions.map((row, i) => i === index ? next : row)});
  const limits = (Object.keys(form.limits) as Array<keyof typeof form.limits>).map(key => <label key={key}>{{maximumPromptTokens: "Maximum prompt tokens", maximumForwardTokenWork: "Maximum forward token work", maximumDurationSeconds: "Maximum duration (seconds)"}[key]}<input value={form.limits[key]} inputMode="numeric" maxLength={100} onChange={event => onChange({...form, limits: {...form.limits, [key]: event.target.value}})} /></label>);
  return <>
    <label>{compact ? "Context (JSON)" : "State (JSON)"}<textarea rows={compact ? 4 : 6} value={form.stateJson} maxLength={131072} onChange={event => onChange({...form, stateJson: event.target.value})} /></label>
    <p>{compact ? "Describe the situation and provide the allowed answers. This model returns a score for each choice." : "Provide unlabeled state and every allowed answer. Approved training targets stay outside scoring input and prompts."}</p>
    {form.questions.map((row, index) => <section key={index} className="evaluation-card">
      <h3>Question {index + 1}</h3>
      {!compact ? <label>Question ID<input value={row.id} maxLength={80} onChange={event => patchQuestion(index, {...row, id: event.target.value})} /></label> : null}
      <label>Question<textarea value={row.description} maxLength={2000} onChange={event => patchQuestion(index, {...row, description: event.target.value})} /></label>
      <label>Answer type<DropdownSelect floating label={`Question ${index + 1} answer type`} value={row.type} options={[{value: "choice", label: "Choice"}, {value: "boolean", label: "Boolean"}, {value: "integer_levels", label: "Integer levels"}]} onChange={type => {
        if (type !== "choice" && type !== "boolean" && type !== "integer_levels") return;
        patchQuestion(index, {...row, type, choices: type === "boolean" ? [{value: "false", description: "False"}, {value: "true", description: "True"}] : [{value: "", description: ""}, {value: "", description: ""}]});
      }} /></label>
      {row.choices.map((choice, choiceIndex) => <div key={choiceIndex} className="model-build-actions">
        <label>{compact ? "Answer" : "Value"}<input value={choice.value} maxLength={256} disabled={row.type === "boolean"} inputMode={row.type === "integer_levels" ? "numeric" : "text"} onChange={event => patchQuestion(index, {...row, choices: row.choices.map((item, i) => i === choiceIndex ? {...item, value: event.target.value} : item)})} /></label>
        <label>{compact ? "Description (optional)" : "Description"}<input value={choice.description} maxLength={2000} onChange={event => patchQuestion(index, {...row, choices: row.choices.map((item, i) => i === choiceIndex ? {...item, description: event.target.value} : item)})} /></label>
        {row.type !== "boolean" ? <button type="button" className="training-text-button" disabled={row.choices.length <= 2} onClick={() => patchQuestion(index, {...row, choices: row.choices.filter((_, i) => i !== choiceIndex)})}>Remove answer</button> : null}
      </div>)}
      {row.type !== "boolean" ? <button type="button" className="training-button secondary" disabled={row.choices.length >= 26} onClick={() => patchQuestion(index, {...row, choices: [...row.choices, {value: "", description: ""}]})}>Add answer</button> : null}
      <button type="button" className="training-text-button" disabled={form.questions.length <= 1} onClick={() => onChange({...form, questions: form.questions.filter((_, i) => i !== index)})}>Remove question</button>
    </section>)}
    <button type="button" className="training-button secondary" disabled={form.questions.length >= 8} onClick={() => {
      let next = form.questions.length + 1;
      while (form.questions.some(row => row.id === `question_${next}`)) next++;
      onChange({...form, questions: [...form.questions, {id: compact ? `question_${next}` : "", type: "choice", description: "", choices: [{value: "", description: ""}, {value: "", description: ""}]}]});
    }}>Add question</button>
    {compact ? <details className="decision-chat-limits"><summary>Scoring limits</summary>{limits}</details> : limits}
  </>;
}
export function DecisionTrainingFields({form, onChange}: {form: Extract<DecisionExperimentFormDraft, {mode: "train"}>; onChange: (form: Extract<DecisionExperimentFormDraft, {mode: "train"}>) => void}) {
  const labels: Record<keyof typeof form.training, string> = {learningRate: "Learning rate", weightDecay: "Weight decay", maxSteps: "Maximum optimizer steps", gradientAccumulationSteps: "Gradient accumulation steps", maximumPromptTokens: "Maximum prompt tokens", seed: "Seed", maxDurationSeconds: "Maximum duration (seconds)", maxCheckpointBytes: "Maximum checkpoint bytes"};
  return <>{(Object.keys(labels) as Array<keyof typeof form.training>).map(key => <label key={key}>{labels[key]}<input value={form.training[key]} inputMode="decimal" maxLength={100} onChange={event => onChange({...form, training: {...form.training, [key]: event.target.value}})} /></label>)}</>;
}
