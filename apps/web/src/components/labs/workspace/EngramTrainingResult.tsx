import type { EngramTrainingResult as Result } from "openpond-sdk/training";
import { EvaluationCard } from "./EvaluationPresentation";

/** Recorded producer metrics and custodied module references. These are not
 * retention, serving or scientific qualification claims. */
export function EngramTrainingResult({result}: {result: Result}) {
  const artifact = result.artifact, manifest = artifact.manifest;
  return <>
    <EvaluationCard title="Training result">
      <dl className="evaluation-workspace-meta">
        <dt>Optimizer steps</dt><dd>{result.optimizerSteps}</dd>
        <dt>Examples processed</dt><dd>{result.examplesProcessed}</dd>
        <dt>Target tokens</dt><dd>{result.targetTokens}</dd>
        <dt>Forward token work</dt><dd>{result.forwardTokenWork}</dd>
        <dt>Mean loss</dt><dd>{result.meanLoss}</dd>
        <dt>Final loss</dt><dd>{result.finalLoss}</dd>
        <dt>Training duration</dt><dd>{(result.durationMs / 1000).toLocaleString()} seconds</dd>
        <dt>Base optimizer parameters</dt><dd>{result.baseOptimizerParameterCount}</dd>
        <dt>Base gradient parameters</dt><dd>{result.baseGradientParameterCount}</dd>
        <dt>Frozen base before</dt><dd className="saved-model-version-reference">{result.baseWeightsHashBefore}</dd>
        <dt>Frozen base after</dt><dd className="saved-model-version-reference">{result.baseWeightsHashAfter}</dd>
        <dt>Result</dt><dd className="saved-model-version-reference">{result.contentHash}</dd>
      </dl>
    </EvaluationCard>
    <EvaluationCard title="Memory module">
      <dl className="evaluation-workspace-meta">
        <dt>Artifact</dt><dd>{artifact.id}</dd>
        <dt>Manifest</dt><dd className="saved-model-version-reference">{artifact.contentHash}</dd>
        <dt>Runtime</dt><dd className="saved-model-version-reference">{manifest.pins.runtimeHash}</dd>
        <dt>Reviewed batch</dt><dd>{manifest.pins.data.batch.id} · release {manifest.pins.data.batch.revision}</dd>
        <dt>Parent adapter</dt><dd className="saved-model-version-reference">{manifest.pins.parentArtifactHash ?? "Fresh adapter"}</dd>
      </dl>
      <details><summary>Committed module files</summary>
        <table className="evaluation-table"><thead><tr><th>File</th><th>Bytes</th><th>SHA-256</th></tr></thead>
          <tbody>{artifact.files.map(file => <tr key={file.path}><td>{file.path}</td><td>{file.sizeBytes.toLocaleString()}</td><td className="saved-model-version-reference">{file.sha256}</td></tr>)}</tbody>
        </table>
      </details>
      <details><summary>Saved adapter tensors</summary>
        <table className="evaluation-table"><thead><tr><th>Tensor</th><th>Shape</th><th>Type</th></tr></thead>
          <tbody>{manifest.payload.tensors.map(tensor => <tr key={tensor.name}><td>{tensor.name}</td><td>{tensor.shape.join(" × ")}</td><td>{tensor.dtype}</td></tr>)}</tbody>
        </table>
      </details>
    </EvaluationCard>
  </>;
}
