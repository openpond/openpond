import { describe, expect, test } from "vitest";

import { createHostedModelStreamFromEnvironment } from "./hosted-model-stream.js";

describe("hosted model stream admission", () => {
  test("requires a host credential and refuses a model change before making a request", async () => {
    expect(() => createHostedModelStreamFromEnvironment({
      OPENPOND_API_KEY: "host-issued-key",
      OPENPOND_OPCHAT_API_URL: "https://api.example.test/opchat/v1",
    })).toThrow("admitted model");

    const stream = createHostedModelStreamFromEnvironment({
      OPENPOND_API_KEY: "host-issued-key",
      OPENPOND_OPCHAT_API_URL: "https://api.example.test/opchat/v1",
      OPENPOND_HOSTED_MODEL_ID: "allowed-model",
    });
    await expect(stream({ model: "other-model", messages: [] }).next())
      .rejects.toThrow("outside host admission");
  });
});
