import type { ExperimentRunConfiguration as Configuration } from "openpond-sdk/experiments";
import { ExperimentGraderLabel } from "./ExperimentGraderLabel";
export function ExperimentRunPins({
  configuration,
  section,
}: {
  configuration: Pick<Configuration, "request" | "graders" | "configurationHash">;
  section: "graders" | "versions";
}) {
  return section === "graders" ? (
    <table className="training-data-table">
      <thead>
        <tr>
          <th>Grader</th>
          <th>Version</th>
          <th>Immutable hash</th>
        </tr>
      </thead>
      <tbody>
        {configuration.graders.map((pin) => (
          <tr key={pin.feedbackKey}>
            <td>
              <ExperimentGraderLabel grader={pin} />
            </td>
            <td>{pin.version}</td>
            <td>
              <code>{pin.contentHash}</code>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  ) : (
    <dl className="evaluation-workspace-meta">
      <dt>Dataset</dt>
      <dd>
        {configuration.request.taskset.id} / v{configuration.request.taskset.revision}
        <small>{configuration.request.taskset.contentHash}</small>
      </dd>
      <dt>Configuration</dt>
      <dd>{configuration.configurationHash}</dd>
      <dt>Profile source</dt>
      <dd>
        {configuration.request.policy.kind === "hosted_harness"
          ? configuration.request.policy.source.sourceRevision
          : "—"}
      </dd>
      <dt>Definition</dt>
      <dd>
        {configuration.request.policy.kind === "hosted_harness"
          ? configuration.request.policy.source.definitionHash
          : "—"}
      </dd>
    </dl>
  );
}
