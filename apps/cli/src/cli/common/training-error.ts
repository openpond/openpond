import { OpenPondTrainingApiError } from "openpond-sdk/training";

/** Preserve actionable API diagnostics without dumping response details. */
export function trainingCliError(error: unknown) {
  if (!(error instanceof OpenPondTrainingApiError)) return null;
  return {
    code: error.code,
    message: error.message,
    status: error.status,
    retryable: error.retryable,
    requestId: error.requestId,
  };
}
