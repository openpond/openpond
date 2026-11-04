import { useQuery } from "@tanstack/react-query";
import { readTrainingFunding } from "./training-compute-api";
import { useExpired } from "./useTrainingExperimentCompute";
import type { WorkspaceApi } from "./workspace-api";
import { canonicalComputeSpendCap } from "openpond-sdk/training";

/** Legacy cap coverage is advisory. Priced compute checks eligible credit at
 * allocation; this client never claims that an allocation is funded. */
export function useTrainingExperimentFunding(
  api: WorkspaceApi,
  budget: string,
  enabled: boolean,
  allocationAdmission = false,
) {
  const maximumSpendUsd = Number(budget);
  let optionalCapValid = false;
  try {
    canonicalComputeSpendCap(budget);
    optionalCapValid = true;
  } catch {
    /* Prepare reports invalid input through the existing action toast. */
  }
  const valid = Boolean(
    api.actorId &&
    (allocationAdmission
      ? optionalCapValid
      : Number.isFinite(maximumSpendUsd) && maximumSpendUsd > 0 && maximumSpendUsd <= 1_000_000),
  );
  const query = useQuery({
    queryKey: [
      "experiment-funding",
      api.connection.serverUrl,
      api.accountKey,
      api.actorId,
      api.teamId,
      maximumSpendUsd,
    ],
    enabled: enabled && valid && !allocationAdmission,
    queryFn: ({ signal }) => {
      if (!valid) throw new Error("Enter a valid maximum spend before checking credits.");
      return readTrainingFunding(
        api,
        {
          schemaVersion: "openpond.trainingFundingRequest.v1",
          teamId: api.teamId,
          maximumSpendUsd,
        },
        signal,
      );
    },
    retry: false,
    staleTime: 0,
  });
  const expired = useExpired(query.data?.expiresAt);
  function assertCovered() {
    if (allocationAdmission) {
      if (!valid) throw new Error("Choose a valid spending limit or use available credits.");
      return;
    }
    if (
      !query.data ||
      query.isFetching ||
      query.isError ||
      Date.parse(query.data.expiresAt) <= Date.now()
    )
      throw new Error("Refresh credits before starting this experiment.");
    if (query.data.state !== "covered")
      throw new Error(
        "This spending cap is not currently funded. Check credits and workspace limits before starting.",
      );
  }
  async function refresh() {
    if (!allocationAdmission) await query.refetch();
  }
  return {
    query,
    valid,
    expired,
    assertCovered,
    allocationAdmission,
    refresh,
    canStart: allocationAdmission
      ? valid
      : Boolean(query.data?.state === "covered" && !expired && !query.isFetching && !query.isError),
  };
}
