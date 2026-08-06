import { describe, expect, test } from "vitest";

import {
  HarnessReleaseSchema as CompatibilityHarnessReleaseSchema,
  contentHash as compatibilityContentHash,
} from "../src/index.js";
import {
  HarnessReleaseSchema,
  contentHash,
} from "@openpond/harness";

describe("@openpond/evals Harness compatibility exports", () => {
  test("re-exports the canonical Harness", () => {
    expect(CompatibilityHarnessReleaseSchema).toBe(HarnessReleaseSchema);
    expect(compatibilityContentHash).toBe(contentHash);
  });
});
