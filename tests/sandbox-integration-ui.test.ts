import { describe, expect, test } from "bun:test";
import {
  integrationLeaseRuntimeAccessLabel,
  sandboxAvailableIntegrationConnectionListInput,
} from "../apps/web/src/components/workspace-diff/SandboxWorkspaceSummary";

describe("sandbox integration UI", () => {
  test("labels runtime proxy availability for integration leases", () => {
    expect(integrationLeaseRuntimeAccessLabel({ proxyUrl: "https://proxy.openpond.ai/lease_x" })).toBe(
      "runtime proxy available",
    );
    expect(integrationLeaseRuntimeAccessLabel({ proxyUrl: null })).toBe("metadata only, no runtime proxy");
  });

  test("asks for account-visible integration connections instead of selected sandbox team connections", () => {
    expect(
      sandboxAvailableIntegrationConnectionListInput({
        teamId: "team_selected",
        projectId: "project_selected",
      }),
    ).toEqual({ status: "active" });
  });
});
