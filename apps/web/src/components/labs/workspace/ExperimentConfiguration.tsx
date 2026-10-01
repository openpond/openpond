import { ExperimentGraderLabel } from "./ExperimentGraderLabel";
import type {
  ExperimentGraderPin,
  ExperimentRunDetails,
  ExperimentScoringPass,
} from "openpond-sdk/experiments";
import { EvaluationCard, EvaluationModel } from "./EvaluationPresentation";
export function ExperimentConfiguration({
  execution,
  pass,
  onOpenGrader,
}: {
  execution: ExperimentRunDetails | null;
  pass: ExperimentScoringPass | null;
  onOpenGrader?: (release: NonNullable<ExperimentGraderPin["release"]>) => void;
}) {
  if (!execution) return <p role="status">Loading exact configuration…</p>;
  const { request, configuration } = execution,
    policy = request.policy;
  return (
    <>
      <EvaluationCard title="Immutable Experiment configuration">
        <dl className="evaluation-workspace-meta">
          <dt>Experiment</dt>
          <dd>{execution.summary.id}</dd>
          <dt>Configuration hash</dt>
          <dd>{configuration.configurationHash}</dd>
          <dt>Manifest hash</dt>
          <dd>{execution.summary.manifestHash}</dd>
          <dt>Dataset</dt>
          <dd>
            {request.taskset.id} / Revision {request.taskset.revision}
          </dd>
          <dt>Dataset hash</dt>
          <dd>{request.taskset.contentHash}</dd>
          <dt>Budget</dt>
          <dd>${configuration.maximumCostUsd} / Policy and graders combined</dd>
          <dt>Target</dt>
          <dd>
            <EvaluationModel name={"modelId" in policy ? policy.modelId : "Authored fixture"} />
          </dd>
          <dt>Population</dt>
          <dd>{request.population.length} cases</dd>
          <dt>Graders</dt>
          <dd>
            {configuration.graders.map((grader) => (
              <ExperimentGraderLabel key={grader.id} grader={grader} onOpen={onOpenGrader} />
            ))}
          </dd>
          <dt>Project</dt>
          <dd>
            {request.project
              ? `${request.project.id} / Revision ${request.project.revision} / ${request.project.contentHash}`
              : "All projects"}
          </dd>
          <dt>Source</dt>
          <dd>
            {policy.kind === "hosted_harness"
              ? `${policy.source.definitionId} / ${policy.source.sourceRevision}`
              : policy.kind === "hosted_chat" && policy.harness
                ? `${policy.harness.harnessRelease.id} / ${policy.harness.harnessRelease.contentHash}`
                : policy.kind === "hosted_chat"
                  ? "Model only"
                  : "Authored fixture"}
          </dd>
          <dt>Execution location</dt>
          <dd>Hosted</dd>
          {configuration.sourceExperimentId ? (
            <>
              <dt>Duplicated from</dt>
              <dd>{configuration.sourceExperimentId}</dd>
            </>
          ) : null}
        </dl>
        <details>
          <summary>Exact grader pins and mappings</summary>
          <pre>{JSON.stringify(configuration.graders, null, 2)}</pre>
        </details>
        {policy.kind === "hosted_chat" ? (
          <details>
            <summary>Model parameters and instructions</summary>
            <pre>
              {JSON.stringify(
                {
                  maxOutputTokens: policy.maxOutputTokens,
                  temperature: policy.temperature,
                  topP: policy.topP,
                  messages: policy.messages ?? [],
                },
                null,
                2,
              )}
            </pre>
          </details>
        ) : null}
      </EvaluationCard>
      {pass ? (
        <EvaluationCard title="Selected scoring pass configuration">
          <dl className="evaluation-workspace-meta">
            <dt>Scoring pass</dt>
            <dd>{pass.id}</dd>
            <dt>Pass hash</dt>
            <dd>{pass.contentHash}</dd>
            <dt>Experiment</dt>
            <dd>
              {pass.request.execution.id} / {pass.request.execution.contentHash}
            </dd>
            <dt>Grading budget</dt>
            <dd>${pass.request.maximumCostUsd}</dd>
            <dt>Graders</dt>
            <dd>
              {pass.graders.map((grader) => (
                <ExperimentGraderLabel key={grader.id} grader={grader} onOpen={onOpenGrader} />
              ))}
            </dd>
          </dl>
          <details>
            <summary>Exact scoring grader pins and mappings</summary>
            <pre>
              {JSON.stringify(
                { graders: pass.graders, mappings: pass.request.mappings ?? [] },
                null,
                2,
              )}
            </pre>
          </details>
        </EvaluationCard>
      ) : null}
    </>
  );
}
