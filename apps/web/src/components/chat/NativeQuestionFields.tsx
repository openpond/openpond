import { useId, useState } from "react";
import type { NativeAgentQuestion } from "@openpond/agent-runtime";
import { DropdownSelect } from "../DropdownSelect";
import { NativeQuestionPreview } from "./NativeQuestionPreview";

type Props = {
  questions: NativeAgentQuestion[];
  answers: Record<string, string>;
  disabled: boolean;
  onChange(answers: Record<string, string>): void;
};

export function NativeQuestionFields({ questions, answers, disabled, onChange }: Props) {
  return (
    <div className="native-question-fields">
      {questions.map((question) => (
        <NativeQuestionField
          key={question.question}
          question={question}
          disabled={disabled}
          answer={answers[question.question] ?? ""}
          onChange={(answer) => onChange({ ...answers, [question.question]: answer })}
        />
      ))}
    </div>
  );
}

function NativeQuestionField({
  question,
  answer,
  disabled,
  onChange,
}: {
  question: NativeAgentQuestion;
  answer: string;
  disabled: boolean;
  onChange(answer: string): void;
}) {
  const inputId = useId();
  const [selected, setSelected] = useState<number[]>([]);
  const [custom, setCustom] = useState(false);
  const [customDraft, setCustomDraft] = useState("");
  const label = custom
    ? "Your answer"
    : selected.map((index) => question.options[index]!.label).join(", ") || "Choose an answer";
  function choose(value: string) {
    if (value === "custom") {
      setCustom(true);
      onChange(customDraft);
      return;
    }
    const index = Number(value);
    const next =
      question.multiSelect && !custom
        ? selected.includes(index)
          ? selected.filter((item) => item !== index)
          : [...selected, index]
        : [index];
    setSelected(next);
    setCustom(false);
    onChange(next.map((item) => question.options[item]!.label).join(", "));
  }
  return (
    <fieldset disabled={disabled}>
      <legend>
        {question.header ? <small>{question.header}</small> : null}
        {question.question}
      </legend>
      <DropdownSelect
        label={question.question}
        disabled={disabled}
        floating
        floatingMenuWidth={380}
        value={custom ? "custom" : selected.length === 1 ? String(selected[0]) : "placeholder"}
        triggerContent={<span>{label}</span>}
        options={[
          { value: "placeholder", label: "Choose an answer", disabled: true },
          ...question.options.map((option, index) => ({
            value: String(index),
            label: `${question.multiSelect && selected.includes(index) && !custom ? "✓ " : ""}${option.label}`,
            description: option.description,
          })),
          { value: "custom", label: "Write your own answer" },
        ]}
        onChange={choose}
      />
      {question.multiSelect && !custom ? (
        <small>Select one or more choices. Choose a selected item again to remove it.</small>
      ) : null}
      {custom ? (
        <label className="native-question-custom" htmlFor={inputId}>
          Your answer
          <textarea
            id={inputId}
            maxLength={8000}
            rows={3}
            value={answer}
            onChange={(event) => {
              setCustomDraft(event.target.value);
              onChange(event.target.value);
            }}
          />
        </label>
      ) : (
        selected.map((index) => {
          const option = question.options[index]!;
          return (
            <div className="native-question-selection" key={index}>
              {option.description ? <p>{option.description}</p> : null}
              {option.preview ? (
                <NativeQuestionPreview preview={option.preview} label={option.label} />
              ) : null}
            </div>
          );
        })
      )}
    </fieldset>
  );
}
