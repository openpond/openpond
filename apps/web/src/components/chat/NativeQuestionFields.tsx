import { useId, useRef, useState } from "react";
import type { NativeAgentQuestion } from "@openpond/agent-runtime";
import type { ClientConnection } from "../../api";
import type { ShowAppToast } from "../../app/app-state";
import { NativeQuestionPreview } from "./NativeQuestionPreview";
import { NativeQuestionAnswer } from "./NativeQuestionAnswer";

type Props = {
  questions: NativeAgentQuestion[];
  answers: Record<string, string>;
  disabled: boolean;
  connection: ClientConnection | null;
  showToast: ShowAppToast;
  onChange(answers: Record<string, string>): void;
  onSubmit(answers: Record<string, string>): void;
  activeVoiceChannel: string | null;
  onVoiceActiveChange(channel: string, active: boolean): void;
};

export function NativeQuestionFields({ questions, answers, onChange, onSubmit, ...props }: Props) {
  const answersRef = useRef(answers);
  answersRef.current = answers;
  return (
    <div className="native-question-fields">
      {questions.map(question => (
        <NativeQuestionField key={question.question} question={question} {...props}
          onChange={(answer, submit = false) => {
            const next = { ...answersRef.current, [question.question]: answer };
            answersRef.current = next;
            onChange(next);
            if (submit) onSubmit(next);
          }} />
      ))}
    </div>
  );
}

function NativeQuestionField({ question, disabled, connection, showToast, onChange, activeVoiceChannel, onVoiceActiveChange }: Omit<Props, "questions" | "answers" | "onChange" | "onSubmit"> & {
  question: NativeAgentQuestion;
  onChange(answer: string, submit?: boolean): void;
}) {
  const inputId = useId();
  const [selected, setSelected] = useState<number[]>([]);
  const [custom, setCustom] = useState(question.options.length === 0);
  const [customDraft, setCustomDraft] = useState("");

  function choose(index: number) {
    const next = question.multiSelect && !custom
      ? selected.includes(index) ? selected.filter(item => item !== index) : [...selected, index]
      : [index];
    setSelected(next);
    setCustom(false);
    onChange(next.map(item => question.options[item]!.label).join(", "));
  }

  return (
    <fieldset disabled={disabled}>
      <legend>{question.header ? <small>{question.header}</small> : null}{question.question}</legend>
      <div className="native-question-options">
        {question.options.map((option, index) => (
          <button key={index} type="button" className="native-question-option" aria-pressed={!custom && selected.includes(index)} onClick={() => choose(index)}>
            <span>{option.label}</span>
            {option.description ? <small>{option.description}</small> : null}
          </button>
        ))}
        {question.options.length ? (
          <button type="button" className="native-question-option custom" aria-pressed={custom} onClick={() => { setCustom(true); onChange(customDraft); }}>Write your own answer</button>
        ) : null}
      </div>
      {question.multiSelect && !custom ? <small>Select one or more.</small> : null}
      {custom ? (
        <NativeQuestionAnswer key={inputId} id={inputId} value={customDraft} disabled={disabled} connection={connection} showToast={showToast}
          activeVoiceChannel={activeVoiceChannel} onVoiceActiveChange={onVoiceActiveChange}
          onChange={(value, submit) => { setCustomDraft(value); onChange(value, submit); }} />
      ) : selected.map(index => {
        const option = question.options[index]!;
        return option.preview ? <NativeQuestionPreview key={index} preview={option.preview} label={option.label} /> : null;
      })}
    </fieldset>
  );
}
