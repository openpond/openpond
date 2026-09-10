import { expect, it } from "vitest";
import { decodeTaskIntakeText, previewTaskIntake } from "../src/learning/intake.js";
import { TASK_INTAKE_LIMITS } from "../src/learning/intake-contracts.js";

// Import must retain source bytes instead of silently normalizing an encoding
// marker or corrupting invalid UTF-8 before its provenance hash is computed.
it("preserves UTF-8 bytes while accepting a file BOM and rejecting invalid encoding", () => {
  for (const format of ["json", "jsonl", "csv"] as const) {
    const plain = format === "csv" ? 'instruction\n"Say café 🦆"' : JSON.stringify({ instruction: "Say café 🦆" });
    const bytes = new TextEncoder().encode(`\uFEFF${plain}`);
    const text = decodeTaskIntakeText(bytes);
    expect(new TextEncoder().encode(text)).toEqual(bytes);
    const preview = previewTaskIntake({ format, files: [{ path: `tasks.${format}`, text }] });
    expect(preview.issues).toEqual([]);
    expect(preview.records[0]?.input).toEqual({ instruction: "Say café 🦆" });
    expect(preview.contentHash).not.toBe(previewTaskIntake({ format, files: [{ path: `tasks.${format}`, text: plain }] }).contentHash);
  }
  expect(() => decodeTaskIntakeText(new Uint8Array([0xc3, 0x28]))).toThrow("valid UTF-8");
});

// Portable imports must preserve private references, source identities and
// incomplete context without silently turning imported labels into approval.
it("parses quoted CSV and keeps references and labels outside the request", () => {
  const preview = previewTaskIntake({ format: "csv", files: [{ path: "tasks.csv", text: 'instruction\n"unterminated' }] });
  const valid = previewTaskIntake({ format: "csv", files: [{ path: "tasks.csv", text: 'instruction,context,reference,labels\r\n"Say ""hello""","two\nlines",private,human' }] });
  expect(preview.issues).toHaveLength(1);
  expect(valid.issues).toEqual([]);
  expect(valid.records[0]).toMatchObject({ input: { instruction: 'Say "hello"', context: "two\nlines" }, expected: { text: "private" }, metadata: { importedLabels: "human", labelOrigin: "unverified_import" } });
  expect(valid.records[0]!.input).not.toHaveProperty("reference");
});

it("reports malformed rows, deduplicates repeated records and rejects split contamination", () => {
  const task = { instruction: "Answer", reference: "secret", id: "one" };
  const file = { path: "tasks.jsonl", text: [JSON.stringify(task), "broken", JSON.stringify(task), JSON.stringify({ ...task, id: "two", split: "test" })].join("\n") };
  const preview = previewTaskIntake({ format: "jsonl", files: [file] });
  expect(preview.records).toHaveLength(1);
  expect(preview.issues.map(issue => issue.row)).toEqual([2, 4]);
  expect(previewTaskIntake({ format: "jsonl", files: [file] })).toEqual(preview);
  expect(previewTaskIntake({ format: "json", files: [{ path: "tasks.json", text: JSON.stringify([task, { ...task, reference: "changed" }]) }] }).issues[0]!.message).toContain("different content");
});

it("retains Hermes turns and compression lineage without leaking the answer into its request", () => {
  const session = { id: "tip", lineage_session_ids: ["root", "tip"], model: "recorded-model", messages: [
    { id: 1, role: "system", content: "Context" }, { id: 2, role: "user", content: "First" },
    { id: 3, role: "assistant", content: null, tool_calls: [{ id: "call", function: { name: "lookup", arguments: "{}" } }] },
    { id: 4, role: "tool", content: "Tool observation", tool_call_id: "call" }, { id: 5, role: "assistant", content: "Answer one" },
    { id: 6, role: "user", content: "Second" }, { id: 7, role: "assistant", content: "Answer two" },
  ] };
  const input = { format: "hermes" as const, files: [{ path: "sessions.jsonl", text: JSON.stringify(session) }] };
  const preview = previewTaskIntake(input);
  expect(preview.issues).toEqual([]);
  expect(preview.records).toHaveLength(2);
  expect(preview.records[0]!.familyKey).toBe(preview.records[1]!.familyKey);
  expect(JSON.stringify(preview.records[0]!.input)).not.toContain("Answer one");
  expect(preview.records[0]!.observedOutput).toMatchObject({ response: "Answer one", messages: [{ tool_calls: [{ id: "call" }] }, { tool_call_id: "call" }, { content: "Answer one" }] });
  expect(preview.records[1]!.metadata).toEqual({ session: { id: "tip", lineage_session_ids: ["root", "tip"], model: "recorded-model" } });
  expect(preview.records.every(record => record.needsContext && record.expected === null)).toBe(true);
});

it("checks OpenClaw bundle identity, branch continuity and exporter warnings", () => {
  const manifest = { traceSchema: "openclaw-trajectory", schemaVersion: 1, traceId: "trace", sessionId: "session", leafId: "b", eventCount: 0,
    warnings: [{ message: "Runtime context was not captured." }] };
  const branch = { header: { id: "session" }, leafId: "b", entries: [
    { id: "a", parentId: null, type: "message", message: { role: "user", content: "Request" } },
    { id: "b", parentId: "a", type: "message", message: { role: "assistant", content: "Response" } },
  ] };
  const files = [{ path: "manifest.json", text: JSON.stringify(manifest) }, { path: "session-branch.json", text: JSON.stringify(branch) }, { path: "events.jsonl", text: "" }];
  const preview = previewTaskIntake({ format: "openclaw", files });
  expect(preview.issues).toEqual([]);
  expect(preview.records[0]!.warnings).toContain("Runtime context was not captured.");
  expect(previewTaskIntake({ format: "openclaw", files: files.slice(0, 2) }).issues[0]!.message).toContain("missing events.jsonl");
  files[1]!.text = JSON.stringify({ ...branch, leafId: "foreign" });
  expect(previewTaskIntake({ format: "openclaw", files }).records).toEqual([]);
});

it("enforces byte and record bounds and rejects unsafe bundle paths", () => {
  expect(() => previewTaskIntake({ format: "json", files: [{ path: "tasks.json", text: "x".repeat(TASK_INTAKE_LIMITS.bytes + 1) }] })).toThrow("5 MiB");
  expect(() => previewTaskIntake({ format: "openclaw", files: [{ path: "../manifest.json", text: "{}" }] })).toThrow("unsafe");
  const preview = previewTaskIntake({ format: "json", files: [{ path: "tasks.json", text: JSON.stringify(Array.from({ length: 1_001 }, () => ({ instruction: "Request" }))) }] });
  expect(preview.records).toEqual([]);
  expect(preview.issues[0]!.message).toContain("1,000-record");
});
