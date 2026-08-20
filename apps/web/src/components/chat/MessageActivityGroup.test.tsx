import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ChatMessage, HarnessRefinerActivity } from "../../lib/app-models";
import { ActivityGroup } from "./MessageActivityGroup";

describe("ActivityGroup", () => {
  it("renders Refiner as its own conversation row after work activity", () => {
    const html = renderToStaticMarkup(
      <ActivityGroup
        activeWorkspaceAppId={null}
        connection={null}
        message={messageWithRefiner()}
      />,
    );

    expect(html).toContain('class="activity-group work-trace settled"');
    expect(html).toContain('class="refiner-activity-row"');
    expect(html.indexOf("Worked for")).toBeLessThan(html.indexOf("refiner-activity-row"));
  });
});

function messageWithRefiner(): ChatMessage {
  return {
    id: "activity-1",
    role: "activity_group",
    timestamp: "2026-08-20T21:00:00.000Z",
    traceState: "completed",
    activities: [{
      id: "activity-1",
      label: "Ran shell command",
      content: "ls",
      timestamp: "2026-08-20T21:00:00.000Z",
      kind: "command",
      state: "completed",
    }],
    refinerActivity: refinerActivity(),
  };
}

function refinerActivity(): HarnessRefinerActivity {
  return {
    state: "completed",
    visibility: "always",
    result: "no_action",
    workspaceId: "workspace-1",
    decision: "no_action",
    route: null,
    operation: null,
    target: null,
    summary: "No reusable change",
    expectedOutcome: null,
    reason: "The task completed.",
    evidenceBasis: null,
    critiqueStatus: "not_applicable",
    validationStatus: "not_applicable",
    validations: [],
    edits: [],
    refs: {
      trigger: null,
      outcome: null,
      proposal: null,
      applyReceipt: null,
      advanceReceipt: null,
      inputHarness: null,
      outputHarness: null,
    },
  };
}
