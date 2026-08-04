import { describe, expect, test } from "vitest";
import { normalizeSandboxApiUrl } from "../packages/cloud/src/sandbox/url.js";

describe("sandbox API URL normalization", () => {
  test.each([
    ["https://api.openpond.ai", "https://api.openpond.ai/v1/sandboxes"],
    [
      "https://staging-api.openpond.ai",
      "https://staging-api.openpond.ai/v1/sandboxes",
    ],
    [
      "https://api.staging-api.openpond.ai",
      "https://api.staging-api.openpond.ai/v1/sandboxes",
    ],
  ])("uses the public v1 sandbox route for %s", (input, expected) => {
    expect(normalizeSandboxApiUrl(input)).toBe(expected);
  });
});
