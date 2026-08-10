import { describe, expect, test } from "vitest";

import type { RuntimeEvent } from "@openpond/contracts";

import {
  isRefinerEvidenceEvent,
  pdfTextBoundsDiagnostic,
} from "./local-harness-refiner-context.js";

describe("local Harness artifact diagnostics", () => {
  test("reports PDF text that extends beyond a page boundary", () => {
    const diagnostic = pdfTextBoundsDiagnostic(
      "board-summary.pdf",
      `<doc><page width="612" height="792">
        <word xMin="-9.146" yMin="39.948" xMax="36.760" yMax="52.898">Summary</word>
        <word xMin="42" yMin="117" xMax="124" yMax="126">Incident</word>
      </page></doc>`,
    );

    expect(diagnostic).toMatchObject({
      path: "board-summary.pdf",
      check: "pdf_text_bounds",
      status: "failed",
      pages: 1,
      clippedTextCount: 1,
      examples: [{ page: 1, text: "Summary", xMin: -9.146 }],
    });
  });

  test("keeps diagnostics in the bounded model-reviewed evidence window", () => {
    expect(isRefinerEvidenceEvent({
      name: "diagnostic",
      action: "taskset_grade",
    } as RuntimeEvent)).toBe(true);
  });
});
