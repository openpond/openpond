import { describe, expect, test } from "vitest";

import { hostedWebBaseUrl } from "../apps/server/src/openpond/saved-work";

describe("hostedWebBaseUrl", () => {
  test("maps public API hosts to their hosted web app", () => {
    expect(
      hostedWebBaseUrl({ OPENPOND_API_URL: "https://staging-api.openpond.ai" })
    ).toBe("https://staging.openpond.ai");
    expect(
      hostedWebBaseUrl({ OPENPOND_API_URL: "https://api.openpond.ai/v1" })
    ).toBe("https://openpond.ai");
  });

  test("preserves an explicitly configured hosted web origin", () => {
    expect(
      hostedWebBaseUrl({
        OPENPOND_HOSTED_WEB_URL: "https://preview.openpond.example/sandboxes",
      })
    ).toBe("https://preview.openpond.example");
  });
});
