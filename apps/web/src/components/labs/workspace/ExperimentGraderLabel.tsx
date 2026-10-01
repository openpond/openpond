import type { ExperimentGraderPin } from "openpond-sdk/experiments";

export function experimentGraderName(graders: readonly ExperimentGraderPin[], feedbackKey: string) {
  return (
    graders.find((grader) => grader.feedbackKey === feedbackKey)?.name || "Grader name unavailable"
  );
}
export function ExperimentGraderLabel({
  grader,
  onOpen,
}: {
  grader: ExperimentGraderPin;
  onOpen?: (release: NonNullable<ExperimentGraderPin["release"]>) => void;
}) {
  const label = grader.name || "Grader name unavailable";
  const title = `${grader.feedbackKey} · Version ${grader.release?.revision ?? grader.version}`;
  return grader.release && onOpen ? (
    <button
      type="button"
      className="evaluation-model-badge"
      title={title}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(grader.release!);
      }}
    >
      {label}
    </button>
  ) : (
    <span className="evaluation-model-badge" title={title}>
      {label}
    </span>
  );
}
