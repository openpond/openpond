import type { AlphaEditComparisons } from "openpond-sdk/training";

/** Measurements on the retained reviewed inputs, separate from latent loss. */
export function AlphaEditResultComparisons({ value }: { value: AlphaEditComparisons }) {
  const { preservation, reload } = value;
  return (
    <section aria-label="AlphaEdit measured comparisons">
      <h4>Measured comparisons</h4>
      <p>
        Measured on reviewed training inputs; held-out quality is unmeasured. Before refers to the{" "}
        {value.startingState === "parent" ? "retained parent patch" : "original base model"}. Target
        NLL means are weighted over target tokens across all contexts.
      </p>
      <div className="evaluation-table-wrap">
        <table className="evaluation-table">
          <caption>Teacher-forced target NLL on reviewed edits</caption>
          <thead>
            <tr>
              <th scope="col">Edit</th>
              <th scope="col">Contexts</th>
              <th scope="col">Target tokens</th>
              <th scope="col">Before NLL</th>
              <th scope="col">After NLL</th>
              <th scope="col">Reloaded NLL</th>
            </tr>
          </thead>
          <tbody>
            {value.edits.map((row) => (
              <tr key={row.id}>
                <td>{row.id}</td>
                <td>{row.contextCount.toLocaleString()}</td>
                <td>{row.targetTokens.toLocaleString()}</td>
                <td>{row.beforeMeanTargetNll}</td>
                <td>{row.afterMeanTargetNll}</td>
                <td>{row.reloadedMeanTargetNll}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="evaluation-table-wrap">
        <table className="evaluation-table">
          <caption>
            Next-token distribution KL across {value.vocabularySize.toLocaleString()} vocabulary
            entries
          </caption>
          <thead>
            <tr>
              <th scope="col">Comparison</th>
              <th scope="col">Measured inputs</th>
              <th scope="col">Mean KL</th>
              <th scope="col">Maximum KL</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Preservation · KL(final edited || starting)</td>
              <td>
                {preservation.examples.toLocaleString()} reviewed examples ·{" "}
                {preservation.comparedPositions.toLocaleString()} final non-padding positions
              </td>
              <td>{preservation.meanNextTokenKl}</td>
              <td>{preservation.maximumNextTokenKl}</td>
            </tr>
            <tr>
              <td>Reload · KL(reloaded patch || final edited)</td>
              <td>
                {reload.comparedTargetTokens.toLocaleString()} target tokens ·{" "}
                {reload.comparedPreservationPositions.toLocaleString()} preservation positions
              </td>
              <td>{reload.meanNextTokenKl}</td>
              <td>{reload.maximumNextTokenKl}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <dl className="evaluation-workspace-meta">
        <dt>Reload reference</dt>
        <dd>Final edited model</dd>
        <dt>Reload equivalence</dt>
        <dd>
          {reload.equivalent
            ? "Equivalent under recorded checks"
            : "Not equivalent under recorded checks"}
        </dd>
        <dt>Absolute tolerance</dt>
        <dd>{reload.absoluteTolerance}</dd>
        <dt>Maximum absolute per-token target NLL difference</dt>
        <dd>{reload.maximumAbsoluteTargetNllDifference}</dd>
        <dt>Maximum absolute log-probability difference</dt>
        <dd>{reload.maximumAbsoluteLogProbabilityDifference}</dd>
      </dl>
    </section>
  );
}
