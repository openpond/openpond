import type { useComposerNextStep } from "./useComposerNextStep";
import { ErrorToast } from "../common/ErrorToast";
import "./composer-next-step.css";

export function ComposerNextStep({ next }: {next:ReturnType<typeof useComposerNextStep>}) {
  return <>
    {next.suggestion ? <div className="composer-next-step" id={next.descriptionId}>
      <span>{next.suggestion.label}</span><small aria-hidden="true">Enter to draft</small>
      <span className="sr-only">Press Enter or Tab to insert an editable draft. This does not send.</span>
    </div> : null}
    <ErrorToast error={next.error} />
  </>;
}
