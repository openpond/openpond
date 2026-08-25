import type { TasksetDraft } from "@openpond/contracts";

export function TasksetDraftValidationStatus({
  draft,
  issues,
}: {
  draft: TasksetDraft;
  issues: string[];
}) {
  return (
    <aside className="taskset-draft-validation" aria-live="polite">
      <div>
        <strong>{issues.length ? "This draft is not publishable yet" : "Ready to publish"}</strong>
        <span>Publishing creates an immutable Taskset revision. It does not start training.</span>
      </div>
      <dl className="taskset-draft-summary">
        <div><dt>Scenarios</dt><dd>{draft.tasks.length}</dd></div>
        <div><dt>Graders</dt><dd>{draft.graders.length}</dd></div>
        <div><dt>Fixtures</dt><dd>{draft.graderFixtures.length}</dd></div>
        <div><dt>Review</dt><dd>{draft.review.enabled ? `${draft.review.candidateCount}-candidate` : "Off"}</dd></div>
        <div><dt>Environment</dt><dd>{draft.environment.kind}</dd></div>
        <div><dt>Metric</dt><dd>{draft.metrics.aggregation}</dd></div>
      </dl>
      {issues.length ? (
        <ol className="taskset-draft-issues">
          {issues.map((issue) => <li key={issue}>{issue}</li>)}
        </ol>
      ) : (
        <div className="taskset-draft-success">
          All authoring checks pass. Use Publish Taskset in the header.
        </div>
      )}
    </aside>
  );
}
