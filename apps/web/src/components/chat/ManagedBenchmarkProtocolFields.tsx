import { useQuery } from "@tanstack/react-query";
import type { ManagedBenchmarkVersions } from "@openpond/contracts/resource-setup";
import type { ClientConnection } from "../../api";
import { chatResourceRequest } from "../../api/chat-resource-api";
import { EvaluationProtocolFields, type EvaluationProtocol } from "../labs/workspace/ExperimentAdvancedSettings";

export function ManagedBenchmarkProtocolFields({
  connection, scope, versions, comparison, draft, onChange, disabled,
}: {
  connection: ClientConnection;
  scope: string;
  versions?: ManagedBenchmarkVersions;
  comparison: boolean;
  draft: EvaluationProtocol;
  onChange(patch: Partial<EvaluationProtocol>): void;
  disabled: boolean;
}) {
  const ready = Boolean(versions && (!comparison || versions.baseline));
  const sampling = useQuery({
    queryKey: ["managed-benchmark-sampling", scope, versions],
    enabled: ready,
    staleTime: 30_000,
    retry: false,
    queryFn: ({ signal }) => chatResourceRequest<{ supported: boolean }>(connection, "dataset", {
      action: "context_benchmark_sampling", payload: versions,
    }, signal),
  });
  const unavailable = !ready ? "Choose the exact Model versions before checking sampling support." :
    sampling.isPending ? "Checking sampling support for the selected versions." :
    sampling.error ? "Sampling support is temporarily unavailable." :
    sampling.data?.supported ? undefined : "Sampling overrides require support from every selected Model version.";
  return <div className="resource-setup-fields resource-setup-protocol-fields">
    <EvaluationProtocolFields draft={draft} patch={onChange} disabled={disabled} supportsSampling={sampling.data?.supported === true && ready}
      samplingUnavailable={unavailable} seedHint="Separate environment seeds with commas. Leave blank to use Seed." />
    {ready && sampling.error ? <button type="button" className="training-text-button" disabled={sampling.isFetching || disabled}
      onClick={() => void sampling.refetch()}>Retry sampling check</button> : null}
  </div>;
}
