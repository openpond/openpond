import type { ExperimentRunConfiguration as Configuration } from "openpond-sdk/experiments";
import type { BenchmarkRunPin } from "@openpond/contracts/resource-setup";
import { ExperimentGraderLabel } from "./ExperimentGraderLabel";
export function ExperimentRunPins({
  configuration,
  section,
  benchmark,
}: {
  configuration: Pick<Configuration, "request" | "graders" | "configurationHash">;
  section: "graders" | "versions";
  benchmark?: BenchmarkRunPin | null;
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
      {benchmark && <>
        <dt>Benchmark</dt><dd>{benchmark.id} / Revision {benchmark.revision}<small>{benchmark.draftHash}</small></dd>
        <dt>Reviewed setup</dt><dd>{benchmark.setupHash}</dd>
      </>}
      {benchmark?.modelVersion && <>
        <dt>Saved Model version</dt><dd>{benchmark.modelVersion.versionHash}</dd>
        <dt>Training artifact</dt><dd>{benchmark.modelVersion.artifact.id}<small>{benchmark.modelVersion.artifact.contentHash}</small></dd>
      </>}
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
