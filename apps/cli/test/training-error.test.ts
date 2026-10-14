import { expect, test } from "vitest";
import { OpenPondTrainingApiError } from "openpond-sdk/training";
import { trainingCliError } from "../src/cli/common/training-error";

// A rejected training artifact must expose its reason without leaking raw details.
test("preserves typed training diagnostics and excludes arbitrary response details", () => {
  const error = new OpenPondTrainingApiError(409, {
    schemaVersion: "openpond.trainingApiError.v2",
    code: "managed_rl_portable_validation_asset_duplicate",
    message: "Training API resource validation failed.",
    retryable: false,
    requestId: "request-123",
    details: { privatePayload: "must not be printed" },
  });
  expect(trainingCliError(error)).toEqual({
    code: error.code, message: error.message, status: 409,
    retryable: false, requestId: "request-123",
  });
  expect(trainingCliError(new Error("other failure"))).toBeNull();
});
