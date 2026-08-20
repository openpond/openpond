import { describe, expect, it } from "vitest";

import { accountEnvironmentForEndpoints } from "./AccountEndpointDialog";

describe("accountEnvironmentForEndpoints", () => {
  it("updates saved account metadata to production when production endpoints are selected", () => {
    expect(
      accountEnvironmentForEndpoints(
        "https://openpond.ai",
        "https://api.openpond.ai"
      )
    ).toBe("production");
  });

  it("marks non-production endpoint pairs as a custom environment", () => {
    expect(
      accountEnvironmentForEndpoints(
        "https://staging.openpond.ai",
        "https://staging-api.openpond.ai"
      )
    ).toBe("custom");
  });
});
