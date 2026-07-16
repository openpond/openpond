import { describe, expect, test } from "vitest";

import { shortProfileAgentLabel } from "../apps/web/src/lib/profile-agent-labels";

describe("profile agent labels", () => {
  test("preserves plural and proper-name endings in generated action ids", () => {
    expect(shortProfileAgentLabel({ actionId: "business-ops-router.chat", label: "Chat" })).toBe(
      "Business Ops Router",
    );
    expect(shortProfileAgentLabel({ actionId: "sales-pipeline-followup.chat", label: "Chat" })).toBe(
      "Sales Pipeline Followup",
    );
  });
});
