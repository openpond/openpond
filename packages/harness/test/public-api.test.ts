import { describe, expect, test } from "vitest";

import {
  HarnessRunOverlaySchema,
  ImprovementObservationSchema,
  ToolDeclarationSchema,
  contentHash,
} from "../src/index.js";

describe("@openpond/harness public API", () => {
  test("exports the portable Harness primitives without Eval contracts", () => {
    expect(contentHash({ harness: true })).toMatch(/^[a-f0-9]{64}$/);
    expect(ToolDeclarationSchema).toBeDefined();
    expect(HarnessRunOverlaySchema).toBeDefined();
    expect(ImprovementObservationSchema).toBeDefined();
  });
});
