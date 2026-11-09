import { expect, test } from "vitest";
import { createTrainingClient, OpenPondTrainingApiError } from "openpond-sdk/training";
import { trainingCliError } from "../src/cli/common/training-error";

// A rejected training artifact must expose its reason without leaking raw details.
test("preserves typed training diagnostics and excludes arbitrary response details", async () => {
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

  // Proxy errors must expose their HTTP status without dumping HTML or headers.
  const client = createTrainingClient({
    baseUrl: "https://api.example.test",
    fetch: async () => new Response("<html>private upstream details</html>", {
      status: 404,
      headers: { "content-type": "text/html; private=hidden", "x-private-debug": "secret" },
    }),
  });
  const failure = await client.getJob("job-fixture").catch((error: unknown) => error);
  expect(trainingCliError(failure)).toMatchObject({
    code: "invalid_error_response", status: 404, retryable: false,
    requestId: null, responseMediaType: "html",
  });
  expect(JSON.stringify(trainingCliError(failure))).not.toMatch(/private|secret|<html>/);
});
