import { ChevronRight } from "lucide-react";

/** Compact failure label in a history row; the full reason and diagnostics expand in place. */
export function ExperimentFailureCell({
  label,
  message,
  onDiagnostics,
}: {
  label: string;
  message?: string | null;
  onDiagnostics: () => void;
}) {
  return (
    <details className="evaluation-failure" onClick={(event) => event.stopPropagation()}>
      <summary title={message ?? label}>
        <ChevronRight size={12} aria-hidden="true" />
        <span>{label}</span>
      </summary>
      <div>
        {message && message !== label ? <p>{message}</p> : null}
        <button type="button" className="evaluation-link-button" onClick={onDiagnostics}>
          Open diagnostics
        </button>
      </div>
    </details>
  );
}
