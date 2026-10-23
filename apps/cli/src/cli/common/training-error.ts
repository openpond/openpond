import { OpenPondTrainingApiError } from "openpond-sdk/training";
import { OpenPondLearningError } from "openpond-sdk/learning";

/** Preserve actionable API diagnostics without dumping response details. */
export function trainingCliError(error: unknown) {
  if (error instanceof OpenPondLearningError) return {
    code: error.code, message: error.message, status: error.status,
    retryable: error.status === 429 || error.status >= 500, requestId: null,
  };
  if (!(error instanceof OpenPondTrainingApiError)) return null;
  return {
    code: error.code,
    message: error.message,
    status: error.status,
    retryable: error.retryable,
    requestId: error.requestId,
  };
}
