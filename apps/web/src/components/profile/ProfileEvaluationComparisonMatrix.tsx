import type { ProfileEvaluationComparison } from "@openpond/evals";

type Member = ProfileEvaluationComparison["members"][number];

function modelLabel(member: Member): string {
  return member.policy.kind === "model"
    ? `${member.policy.model.provider}/${member.policy.model.model}` : "Fixture";
}

/** The saved comparison owns membership; this projection never adds later
 * runs or changes its frozen Taskset population. */
export function ProfileEvaluationComparisonMatrix({ comparison }: { comparison: ProfileEvaluationComparison }) {
  const sources = [...new Set(comparison.members.map((member) => member.source.sourceRevision))];
  const models = [...new Set(comparison.members.map(modelLabel))];
  return (
    <table className="profile-evaluations-comparison-matrix">
      <caption>Same frozen Taskset {comparison.tasksetRelease.id} across Profile source and model choices</caption>
      <thead><tr><th scope="col">Profile source</th>{models.map((model) => <th key={model} scope="col">{model}</th>)}</tr></thead>
      <tbody>{sources.map((source) => (
        <tr key={source}>
          <th scope="row" title={source}>{source.slice(0, 12)}</th>
          {models.map((model) => {
            const members = comparison.members.filter((member) => member.source.sourceRevision === source && modelLabel(member) === model);
            return <td key={model}>{members.length ? members.map((member) => (
              <div key={member.runManifest.id}>
                <strong>{member.score === null ? "No score" : `${Math.round(member.score * 100)}%`}</strong>
                <small> · Run {member.runManifest.id}</small>
              </div>
            )) : "—"}</td>;
          })}
        </tr>
      ))}</tbody>
    </table>
  );
}
