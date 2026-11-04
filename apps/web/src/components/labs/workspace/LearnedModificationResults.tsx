import type { AlphaEditTrainingResult, NeuronTrainingResult } from "openpond-sdk/training";
import { AlphaEditResultComparisons } from "./AlphaEditResultComparisons";
import { EvaluationCard } from "./EvaluationPresentation";

type Result = AlphaEditTrainingResult | NeuronTrainingResult;

/** Canonical output evidence; rendering a result grants no execution authority. */
export function LearnedModificationResults({ result }: { result: Result }) {
  const alphaEdit = result.schemaVersion === "openpond.alphaEditTrainingResult.v1";
  return (
    <EvaluationCard title={alphaEdit ? "AlphaEdit result" : "Neuron training result"}>
      <dl className="evaluation-workspace-meta">
        <dt>Duration</dt>
        <dd>{(result.durationMs / 1000).toLocaleString()} seconds</dd>
        <dt>Forward token work</dt>
        <dd>{result.forwardTokenWork.toLocaleString()}</dd>
        {result.schemaVersion === "openpond.alphaEditTrainingResult.v1" ? (
          <>
            <dt>Edits processed</dt>
            <dd>{result.editsProcessed}</dd>
            <dt>Latent optimizer steps</dt>
            <dd>{result.latentOptimizerSteps}</dd>
            <dt>Untouched weights before</dt>
            <dd className="saved-model-version-reference">{result.untouchedWeightsHashBefore}</dd>
            <dt>Untouched weights after</dt>
            <dd className="saved-model-version-reference">{result.untouchedWeightsHashAfter}</dd>
            <dt>Edited weights before</dt>
            <dd className="saved-model-version-reference">{result.editedWeightsHashBefore}</dd>
            <dt>Edited weights after</dt>
            <dd className="saved-model-version-reference">{result.editedWeightsHashAfter}</dd>
          </>
        ) : (
          <>
            <dt>Selection</dt>
            <dd>
              {result.selection.source} · {result.selection.entries.length} of{" "}
              {result.selection.eligibleCount.toLocaleString()} eligible neurons
            </dd>
            <dt>Optimizer steps</dt>
            <dd>{result.optimizerSteps}</dd>
            <dt>Examples processed</dt>
            <dd>{result.examplesProcessed}</dd>
            <dt>Trainable parameters</dt>
            <dd>{result.trainableParameterCount.toLocaleString()}</dd>
            <dt>Mean loss</dt>
            <dd>{result.meanLoss}</dd>
            <dt>Final loss</dt>
            <dd>{result.finalLoss}</dd>
            <dt>Mean preservation KL</dt>
            <dd>{result.meanPreservationKl ?? "Preservation disabled"}</dd>
            <dt>Base weights before</dt>
            <dd className="saved-model-version-reference">{result.baseWeightsHashBefore}</dd>
            <dt>Base weights after</dt>
            <dd className="saved-model-version-reference">{result.baseWeightsHashAfter}</dd>
          </>
        )}
      </dl>
      {result.schemaVersion === "openpond.alphaEditTrainingResult.v1" ? (
        <>
          <AlphaEditResultComparisons value={result.comparisons} />
          <div className="evaluation-table-wrap">
            <table className="evaluation-table">
              <caption>Latent target optimization objective</caption>
              <thead>
                <tr>
                  <th>Edit</th>
                  <th>Initial loss</th>
                  <th>Final loss</th>
                  <th>Optimizer steps</th>
                </tr>
              </thead>
              <tbody>
                {result.targetLosses.map((row) => (
                  <tr key={row.id}>
                    <td>{row.id}</td>
                    <td>{row.initial}</td>
                    <td>{row.final}</td>
                    <td>{row.optimizerSteps}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="evaluation-table-wrap">
            <table className="evaluation-table">
              <caption>Layer evidence</caption>
              <thead>
                <tr>
                  <th>Layer</th>
                  <th>Preservation tokens</th>
                  <th>Nullspace rank</th>
                  <th>Update norm</th>
                  <th>Solve residual</th>
                  <th>Sequential keys</th>
                </tr>
              </thead>
              <tbody>
                {result.layerEvidence.map((row) => (
                  <tr key={row.layer}>
                    <td>{row.layer}</td>
                    <td>{row.preservationTokens}</td>
                    <td>{row.nullspaceRank}</td>
                    <td>{row.updateFrobeniusNorm}</td>
                    <td>{row.solveRelativeResidual}</td>
                    <td>{row.sequentialKeyCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="evaluation-table-wrap">
          <table className="evaluation-table">
            <caption>Selected neurons</caption>
            <thead>
              <tr>
                <th>Layer</th>
                <th>Neuron</th>
                <th>Target activity</th>
                <th>Background activity</th>
                <th>Ratio</th>
                <th>Gradient norm</th>
                <th>Score</th>
              </tr>
            </thead>
            <tbody>
              {result.selection.entries.map((row) => (
                <tr key={`${row.layer}:${row.neuron}`}>
                  <td>{row.layer}</td>
                  <td>{row.neuron}</td>
                  <td>{row.targetMeanAbsolute}</td>
                  <td>{row.backgroundMeanAbsolute}</td>
                  <td>{row.backgroundTargetRatio}</td>
                  <td>{row.gradientNorm}</td>
                  <td>{row.score}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="evaluation-table-wrap">
        <table className="evaluation-table">
          <caption>Committed output files</caption>
          <thead>
            <tr>
              <th>File</th>
              <th>Bytes</th>
              <th>SHA-256</th>
            </tr>
          </thead>
          <tbody>
            {result.artifact.files.map((row) => (
              <tr key={row.path}>
                <td>{row.path}</td>
                <td>{row.sizeBytes.toLocaleString()}</td>
                <td className="saved-model-version-reference">{row.sha256}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="evaluation-workspace-meta">
        <dt>Artifact</dt>
        <dd>{result.artifact.id}</dd>
        <dt>Artifact hash</dt>
        <dd className="saved-model-version-reference">{result.artifact.contentHash}</dd>
        <dt>Result hash</dt>
        <dd className="saved-model-version-reference">{result.contentHash}</dd>
      </dl>
      <details>
        <summary>Complete retained evidence</summary>
        <pre className="saved-model-version-reference">{JSON.stringify(result, null, 2)}</pre>
      </details>
    </EvaluationCard>
  );
}
