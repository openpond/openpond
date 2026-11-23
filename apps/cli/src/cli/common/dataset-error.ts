import { DatasetWorkspaceRequestError } from "openpond-sdk/dataset-workspaces";

/** Preserve bounded recovery identity without exposing server response bodies. */
export function datasetCliError(error: unknown) {
  if (!(error instanceof DatasetWorkspaceRequestError)) return null;
  return {
    code: error.code, message: error.message, status: error.status,
    retryable: error.retryable, outcomeUnknown: error.outcomeUnknown,
  };
}
