import { useState, type ReactNode } from "react";
import type { ActivationReferenceRequest, ActivationReferenceResult } from "openpond-sdk/training";
import { DropdownSelect } from "../../DropdownSelect";
import { EvaluationCard } from "./EvaluationPresentation";
import { Pagination } from "../LabsRouteSections";

/** Shared verified capture presentation for external observations and canonical hosted results. */
export function ActivationCaptureResult({
  request,
  result,
  trainingAction,
}: {
  request: ActivationReferenceRequest;
  result: ActivationReferenceResult;
  trainingAction?: ReactNode;
}) {
  const [prompt, setPrompt] = useState(""),
    [variant, setVariant] = useState(""),
    [coordinate, setCoordinate] = useState("");
  const [page, setPage] = useState(1);
  const promptId = request?.prompts.some((row) => row.id === prompt)
    ? prompt
    : request?.prompts[0]?.id;
  const variantId = request?.variants.some((row) => row.id === variant)
    ? variant
    : request?.variants[0]?.id;
  const coordinates =
    request?.capture.flatMap((row) =>
      row.neurons.map((neuron) => ({
        value: `${row.layer}:${neuron}`,
        label: `Layer ${row.layer} · Neuron ${neuron}`,
      })),
    ) ?? [];
  const selectedCoordinate = coordinates.some((row) => row.value === coordinate)
    ? coordinate
    : coordinates[0]?.value;
  const captures =
    result?.captures.filter(
      (row) =>
        row.promptId === promptId &&
        row.variantId === variantId &&
        `${row.layer}:${row.neuron}` === selectedCoordinate,
    ) ?? [];
  const outcome = result?.outcomes.find(
    (row) => row.promptId === promptId && row.variantId === variantId,
  );
  const currentPage = Math.min(page, Math.max(1, Math.ceil(captures.length / 10)));
  return (
    <>
      <EvaluationCard title="Activation capture">
        <label className="model-build-field">
          Prompt
          <DropdownSelect
            label="Captured prompt"
            floating
            value={promptId ?? ""}
            options={request.prompts.map((row) => ({ value: row.id, label: row.id }))}
            onChange={(value) => {
              setPrompt(value);
              setPage(1);
            }}
          />
        </label>
        <label className="model-build-field">
          Variant
          <DropdownSelect
            label="Captured variant"
            floating
            value={variantId ?? ""}
            options={request.variants.map((row) => ({
              value: row.id,
              label: row.profile ? row.id : `${row.id} · Off`,
            }))}
            onChange={(value) => {
              setVariant(value);
              setPage(1);
            }}
          />
        </label>
        <label className="model-build-field">
          Coordinate
          <DropdownSelect
            label="Captured coordinate"
            floating
            value={selectedCoordinate ?? ""}
            options={coordinates}
            onChange={(value) => {
              setCoordinate(value);
              setPage(1);
            }}
          />
        </label>
      </EvaluationCard>
      {trainingAction}
      <p>
        {outcome?.generatedTokenIds.length ?? 0} generated tokens · {outcome?.forwardTokenWork ?? 0}{" "}
        forward-token work. Token IDs are retained against the exact tokenizer; no semantic feature
        labels are inferred.
      </p>
      <EvaluationCard title="Generated token comparison">
        <div className="evaluation-table-scroll">
          <table className="training-data-table evaluation-workspace-table">
            <thead>
              <tr>
                <th>Variant</th>
                <th>Generated token IDs</th>
              </tr>
            </thead>
            <tbody>
              {request.variants.map((item) => {
                const output = result.outcomes.find(
                  (row) => row.promptId === promptId && row.variantId === item.id,
                );
                return (
                  <tr key={item.id}>
                    <td>{item.profile ? item.id : `${item.id} · Off`}</td>
                    <td>
                      <code>{output?.generatedTokenIds.join(" ") || "—"}</code>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </EvaluationCard>
      <EvaluationCard title="Activation values">
        <p>
          Before and after values are inputs to down_proj for the selected variant. Token indices
          exclude prompt padding.
        </p>
        <div className="evaluation-table-scroll evaluation-table-frame">
          <table className="training-data-table evaluation-workspace-table">
            <thead>
              <tr>
                <th>Token index</th>
                <th>Token ID</th>
                <th>Before</th>
                <th>After</th>
                <th>Delta</th>
              </tr>
            </thead>
            <tbody>
              {captures.slice((currentPage - 1) * 10, currentPage * 10).map((row) => (
                <tr key={row.tokenIndex}>
                  <td>{row.tokenIndex}</td>
                  <td>{row.tokenId}</td>
                  <td>{row.before.toPrecision(7)}</td>
                  <td>{row.after.toPrecision(7)}</td>
                  <td>
                    {Number.isFinite(row.after - row.before)
                      ? (row.after - row.before).toPrecision(7)
                      : "Outside numeric range"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pagination page={currentPage} total={captures.length} onChange={setPage} />
      </EvaluationCard>
      <details>
        <summary>Exact configuration and evidence</summary>
        <pre>
          {JSON.stringify(
            {
              model: request.model,
              variant: request.variants.find((row) => row.id === variantId),
              prompt: request.prompts.find((row) => row.id === promptId),
              outcome,
            },
            null,
            2,
          )}
        </pre>
      </details>
    </>
  );
}
