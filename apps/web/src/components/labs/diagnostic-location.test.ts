import { expect, it } from "vitest";
import { diagnosticLocationHash } from "./diagnostic-location";

// Startup canonicalization previously erased the user's retained attempt/evidence
// selection. Preserve that scoped selection without retaining connection secrets.
it("keeps bounded diagnostics deep links and rejects other fragments", () => {
  const location = { pathname: "/console/experiments/mrun_example/diagnostics", search: "?location=hosted" };
  expect(diagnosticLocationHash({ ...location, hash: "#diagnostic-attempt=1&event=event_42" })).toBe("#diagnostic-attempt=1&event=event_42");
  expect(diagnosticLocationHash({ ...location, hash: "#diagnostic-task=columbia-pdf-1" })).toBe("#diagnostic-task=columbia-pdf-1");
  expect(diagnosticLocationHash({ ...location, hash: "#openpondToken=private" })).toBe("");
  expect(diagnosticLocationHash({ ...location, hash: "#diagnostic-attempt=1&diagnostic-attempt=2" })).toBe("");
  expect(diagnosticLocationHash({ ...location, hash: "#diagnostic-attempt=-1" })).toBe("");
  expect(diagnosticLocationHash({ ...location, hash: `#event=${"a".repeat(501)}` })).toBe("");
  expect(diagnosticLocationHash({ ...location, pathname: "/console/experiments/mrun_example/tasks", hash: "#event=event_42" })).toBe("");
});
