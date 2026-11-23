import { expect, test } from "vitest";
import { DatasetWorkspaceRequestError } from "openpond-sdk/dataset-workspaces";
import { datasetCliError } from "../src/cli/common/dataset-error";

// An uncertain write must retain its recovery signal, without making arbitrary
// response properties part of the machine-readable CLI error contract.
test("preserves safe dataset recovery identity and excludes arbitrary response details", () => {
  const error = new DatasetWorkspaceRequestError(503, "dataset_request_failed");
  Object.assign(error, { privateBody: "private fixture response" });
  expect(datasetCliError(error)).toEqual({
    code: "dataset_request_failed", message: "Dataset request failed (503).",
    status: 503, retryable: true, outcomeUnknown: true,
  });
  expect(JSON.stringify(datasetCliError(error))).not.toContain("private fixture");
  expect(datasetCliError(new DatasetWorkspaceRequestError(409, "dataset_revision_conflict")))
    .toMatchObject({ code: "dataset_revision_conflict", status: 409, retryable: false, outcomeUnknown: false });
  expect(datasetCliError(new Error("untrusted failure"))).toBeNull();
});
