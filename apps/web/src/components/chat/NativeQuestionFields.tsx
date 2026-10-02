import type { NativeAgentQuestion } from "@openpond/agent-runtime";

export function NativeQuestionFields({ questions, answers, disabled, onChange }: {
  questions: NativeAgentQuestion[];
  answers: Record<string, string>;
  disabled: boolean;
  onChange(answers: Record<string, string>): void;
}) {
  return <div className="native-question-fields">{questions.map((question) => <fieldset key={question.question} disabled={disabled}>
    <legend>{question.question}</legend>
    {question.options.map((option) => {
      const selected = (answers[question.question] ?? "").split(", ");
      return <label key={option.label} title={option.description}>
        <input type={question.multiSelect ? "checkbox" : "radio"} name={question.question} checked={selected.includes(option.label)} onChange={(event) => {
          const value = question.multiSelect ? (event.target.checked ? [...selected.filter(Boolean), option.label] : selected.filter((label) => label !== option.label)).join(", ") : option.label;
          onChange({ ...answers, [question.question]: value });
        }} />{option.label}{option.description ? <small>{option.description}</small> : null}
      </label>;
    })}
    <label>Your answer<input type="text" maxLength={8000} value={answers[question.question] ?? ""} onChange={(event) => onChange({ ...answers, [question.question]: event.target.value })} /></label>
  </fieldset>)}</div>;
}
