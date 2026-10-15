import type { useComposerNextStep } from "./useComposerNextStep";
import { ErrorToast } from "../common/ErrorToast";
import "./composer-next-step.css";

export function ComposerNextStep({ next }: {next:ReturnType<typeof useComposerNextStep>}) {
  return <>
    {next.suggestion ? <div className="composer-next-step" aria-label="Suggested next step">
      <button type="button" className="composer-next-step-accept" title={next.suggestion.draft}
        aria-label={`${next.suggestion.label}. Insert an editable draft; this does not send.`}
        onMouseDown={event=>event.preventDefault()} onClick={()=>void next.accept()}>
        <span>{next.suggestion.label}</span><small>Tab or Enter to draft</small>
      </button>
      <button type="button" className="composer-next-step-dismiss" aria-label="Dismiss suggested next step" onClick={next.dismiss}>×</button>
    </div> : null}
    <ErrorToast error={next.error} />
  </>;
}
