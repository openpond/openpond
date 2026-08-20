import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { HarnessRefinerActivity } from "../../lib/app-models";
import { HarnessRefinerReceipt } from "./HarnessRefinerReceipt";

describe("HarnessRefinerReceipt", () => {
  it("renders concise applied, retained, routed, failed, and no-action labels", () => {
    expect(render("applied")).toContain("Refiner · Updated PDF skill — Applied");
    expect(render("retained")).toContain("Refiner · Updated PDF skill — Needs review");
    expect(render("routed")).toContain("Refiner · Runtime issue routed");
    expect(render("failed")).toContain("Refiner · Review failed");
    expect(render("no_action")).toContain("Refiner · No reusable change");
  });

  it("keeps exact edits and receipt details collapsed behind the summary", () => {
    const html = renderToStaticMarkup(
      <HarnessRefinerReceipt activity={activity("applied")} />,
    );

    expect(html).toContain("aria-expanded=\"false\"");
    expect(html).toContain("Updated PDF skill — Applied");
    expect(html).not.toContain("New exact skill content");
    expect(html).not.toContain("Validation passed");
  });

  it("renders the authorized details, validation, exact edit, and release refs when expanded", () => {
    const html = renderToStaticMarkup(
      <HarnessRefinerReceipt activity={activity("applied")} defaultExpanded />,
    );

    expect(html).toContain("aria-expanded=\"true\"");
    expect(html).toContain("Expected outcome");
    expect(html).toContain("Validation passed");
    expect(html).toContain("Review 1 exact edit");
    expect(html).toContain("New exact skill content");
    expect(html).toContain("Receipt references");
    expect(html).toContain("Trigger");
    expect(html).toContain("Outcome");
    expect(html).toContain("Input Harness");
    expect(html).toContain("harness-2 · aaaaaaaaaaaa");
  });
});

function render(result: HarnessRefinerActivity["result"]): string {
  return renderToStaticMarkup(<HarnessRefinerReceipt activity={activity(result)} />);
}

function activity(result: HarnessRefinerActivity["result"]): HarnessRefinerActivity {
  const failed = result === "failed";
  const proposal = result === "applied" || result === "retained";
  const routed = result === "routed";
  return {
    state: failed ? "failed" : "completed",
    visibility: "always",
    result,
    workspaceId: "workspace-1",
    decision: proposal ? "propose" : routed ? "route" : result === "no_action" ? "no_action" : null,
    route: proposal ? "skill" : routed ? "runtime" : null,
    operation: proposal ? "update" : null,
    target: proposal ? "skills/pdf/SKILL.md" : null,
    summary: proposal ? "Updated PDF skill" : "No reusable change",
    expectedOutcome: proposal ? "Future PDF work uses the corrected workflow." : null,
    reason: failed ? "Provider request failed." : "The bounded evidence supports this result.",
    evidenceBasis: null,
    critiqueStatus: proposal ? "passed" : "not_applicable",
    validationStatus: proposal ? "passed" : "not_applicable",
    validations: proposal
      ? [{ id: "validation-1", status: "passed", summary: "Validation passed." }]
      : [],
    edits: proposal
      ? [{
          id: "edit-1",
          operation: "update",
          target: "skills/pdf/SKILL.md",
          summary: "Updated PDF skill",
          content: "New exact skill content",
        }]
      : [],
    refs: {
      trigger: "trigger-1 · aaaaaaaaaaaa",
      outcome: failed ? null : "outcome-1 · aaaaaaaaaaaa",
      proposal: proposal ? "proposal-1 · aaaaaaaaaaaa" : null,
      applyReceipt: proposal ? "apply-1 · aaaaaaaaaaaa" : null,
      advanceReceipt: result === "applied" ? "advance-1 · aaaaaaaaaaaa" : null,
      inputHarness: "harness-1 · aaaaaaaaaaaa",
      outputHarness: result === "applied" ? "harness-2 · aaaaaaaaaaaa" : null,
    },
  };
}
