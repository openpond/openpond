import { describe, expect, test } from "vitest";
import {
  WORK_FORMAT_CAPABILITIES,
  WORK_OUTPUT_CONTENT_TYPES,
  workFormatCapabilityForContentType,
} from "@openpond/contracts";

describe("Work format capability matrix", () => {
  test("maps every advertised extension to a MIME type and validation policy", () => {
    const extensions = new Set<string>();
    for (const capability of WORK_FORMAT_CAPABILITIES) {
      expect(capability.extensions.length).toBeGreaterThan(0);
      expect(capability.contentTypes.length).toBeGreaterThan(0);
      expect(capability.validation.length).toBeGreaterThan(0);
      for (const extension of capability.extensions) {
        expect(extension.startsWith(".")).toBe(true);
        expect(extensions.has(extension)).toBe(false);
        extensions.add(extension);
        expect(WORK_OUTPUT_CONTENT_TYPES[extension]).toBeTruthy();
      }
      for (const contentType of capability.contentTypes) {
        expect(workFormatCapabilityForContentType(contentType)?.family).toBe(
          capability.family
        );
      }
    }
  });
});
