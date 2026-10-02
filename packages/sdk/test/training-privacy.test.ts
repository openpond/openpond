import { expect, it } from "vitest";
import { scanAndRedactEvidence } from "../src/training-privacy.js";

// Captured tool payloads are serialized JSON. Quoted property names must not
// bypass the same credential check that protects free-text assignments.
it("blocks credentials in retained JSON and text without marking ordinary evidence unsafe", () => {
  const secret = "fixtureCredential12345";
  for (const text of [
    `password=${secret}`,
    JSON.stringify({ nested: { api_key: secret } }),
    `{'token': '${secret}'}`,
  ]) {
    const result = scanAndRedactEvidence(text);
    expect(result.secretStatus).toBe("blocked");
    expect(result.redacted).not.toContain(secret);
  }
  const ordinary = scanAndRedactEvidence(JSON.stringify({
    invoiceNumber: "INV-1-005", date: "2026-08-05", total: 11.4,
  }));
  expect(ordinary.secretStatus).toBe("passed");
  expect(ordinary.piiStatus).toBe("passed");
});
