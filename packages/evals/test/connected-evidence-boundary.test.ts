import { describe, expect, it } from "vitest";
import { contentHash } from "@openpond/harness";
import { previewAgentImport, resolveConnectedBoundary, summarizeConnectedInvocations } from "../src/connected-evidence/index.js";
import { scanAndRedactEvidence } from "../../sdk/src/training-privacy.js";

const file = (path: string, rows: unknown[]) => ({ path, text: rows.map(row => JSON.stringify(row)).join("\n") });
const at = "2026-10-01T00:00:00.000Z";
const codex = (answer = "first answer") => file("rollout.jsonl", [
  { type: "session_meta", payload: { id: "session-1", cli_version: "0.1" } },
  { type: "response_item", timestamp: at, payload: { id: "u1", type: "message", role: "user", content: [{ type: "input_text", text: "first request" }] } },
  { type: "event_msg", timestamp: at, payload: { type: "user_message", message: "first request" } },
  { type: "response_item", timestamp: at, payload: { id: "call", type: "function_call", call_id: "tool-1", name: "read", arguments: "{}" } },
  { type: "response_item", timestamp: at, payload: { id: "result", type: "function_call_output", call_id: "tool-1", output: "retained tool output" } },
  { type: "response_item", timestamp: at, payload: { id: "a1", type: "message", role: "assistant", content: [{ type: "output_text", text: answer }] } },
  { type: "event_msg", timestamp: at, payload: { type: "task_complete" } },
  { type: "response_item", timestamp: at, payload: { id: "u2", type: "message", role: "user", content: [{ type: "input_text", text: "second request" }] } },
  { type: "response_item", timestamp: at, payload: { id: "a2", type: "message", role: "assistant", content: [{ type: "output_text", text: "future secret answer" }] } },
]);
describe("connected evidence immutable admission boundary", () => {
  // Native approval rules can contain credentials. Excluding that authorization
  // state must not become a blanket removal of user, tool or system evidence.
  it("excludes only Codex native approved rules with immutable source provenance", () => {
    const nativeAuthority = "token=fixtureNativeAuthority123";
    const instruction = `<permissions instructions>\nRetain sandbox policy.\n## Approved command prefixes\nThe following prefix rules have already been approved: - [\"${nativeAuthority}\"]\n</permissions instructions>\nRetain following instructions.`;
    const rows = [
      { type: "session_meta", payload: { id: "privacy-session", cli_version: "0.153.4" } },
      { type: "response_item", payload: { id: "system", type: "message", role: "developer", content: [{ type: "input_text", text: instruction }] } },
      { type: "world_state", payload: { full: true, state: { model: "retained-model", permissions: { instructions: "retained permissions policy", approved_command_prefixes: [[nativeAuthority]] } } } },
      { type: "response_item", payload: { id: "request", type: "message", role: "user", content: "Explain approved_command_prefixes and ## Approved command prefixes." } },
      { type: "response_item", payload: { id: "call", type: "function_call", call_id: "tool", name: "read", arguments: "approved_command_prefixes" } },
      { type: "response_item", payload: { id: "result", type: "function_call_output", call_id: "tool", output: "## Approved command prefixes is ordinary tool evidence." } },
      { type: "response_item", payload: { id: "answer", type: "message", role: "assistant", content: "retained answer" } },
      { type: "event_msg", payload: { type: "task_complete" } },
    ];
    const source = file("authorization.jsonl", rows);
    const sourceHash = contentHash(source.text);
    const normalize = (value: typeof source) => previewAgentImport({ source: "codex", files: [value], acquisition: { machineId: "machine", sourceInstanceId: "instance" } }).sessions[0]!;
    const session = normalize(source), serialized = JSON.stringify(session);
    expect(serialized).not.toContain(nativeAuthority);
    expect(scanAndRedactEvidence(serialized).secretStatus).toBe("passed");
    expect(session.sourceFiles[0]?.contentHash).toBe(sourceHash);
    expect(contentHash(source.text)).toBe(sourceHash);
    expect(serialized).toContain("codex-native-authorization-v1");
    expect(serialized).toContain(contentHash([[nativeAuthority]]));
    for (const retained of ["Retain sandbox policy.", "Retain following instructions.", "retained-model", "retained permissions policy", "ordinary tool evidence", "retained answer"])
      expect(serialized).toContain(retained);
    const boundary = session.boundaries.find(item => item.projection === "turn")!;
    expect(resolveConnectedBoundary(session, boundary.id).answer).toBe("retained answer");
    // The same syntax in a user message or actual tool output is never scrubbed.
    for (const index of [3, 5]) {
      const unsafe = structuredClone(rows);
      const payload = unsafe[index]!.payload as Record<string, unknown>;
      payload[index === 3 ? "content" : "output"] = instruction;
      const retained = normalize(file(source.path, unsafe));
      expect(JSON.stringify(retained.events)).toContain(nativeAuthority);
      expect(scanAndRedactEvidence(JSON.stringify(retained)).secretStatus).toBe("blocked");
    }
  });
  // Failure story: mirrored events or a later answer can change the admitted population or leak into grading input.
  it("deduplicates Codex mirrored messages, pins cutoffs, and rejects mutated bytes", () => {
    const preview = previewAgentImport({ source: "codex", files: [codex()] });
    expect(preview.issues).toEqual([]);
    const session = preview.sessions[0]!, turns = session.boundaries.filter(boundary => boundary.projection === "turn");
    expect(turns).toHaveLength(2);
    const first = resolveConnectedBoundary(session, turns[0]!.id);
    expect(JSON.stringify(first.input)).not.toContain("first answer");
    expect(JSON.stringify(first.observed)).not.toContain("future secret answer");
    expect(first.boundary.coverage.process).toBe("retained");
    const changed = previewAgentImport({ source: "codex", files: [codex("changed answer")] }).sessions[0]!;
    expect(changed.boundaries[0]!.inputHash).toBe(turns[0]!.inputHash);
    expect(changed.boundaries[0]!.revisionHash).not.toBe(turns[0]!.revisionHash);
    const mutated = structuredClone(session); mutated.events[1]!.content = "tampered";
    expect(() => resolveConnectedBoundary(mutated, turns[0]!.id)).toThrow("connected_evidence_hash_mismatch");
  });
  // Failure story: an ambiguous branch silently combines mutually exclusive outputs or tool results become user tasks.
  it("requires Claude branch selection and retains tool-only usage without inventing a request", () => {
    const rows = [
      { uuid: "u", parentUuid: null, sessionId: "claude", type: "user", timestamp: at, message: { content: "request" } },
      { uuid: "a", parentUuid: "u", sessionId: "claude", type: "assistant", timestamp: at, message: { id: "invocation", content: [{ type: "tool_use", id: "call", name: "read", input: {} }], usage: { input_tokens: 4, output_tokens: 2 } } },
      { uuid: "r", parentUuid: "a", sessionId: "claude", type: "user", timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: "call", content: "result" }] } },
      { uuid: "end", parentUuid: "r", sessionId: "claude", type: "assistant", timestamp: at, message: { content: "answer", stop_reason: "end_turn" } },
      { uuid: "fork", parentUuid: "u", sessionId: "claude", type: "assistant", timestamp: at, message: { content: "other branch" } },
    ];
    const source = file("session.jsonl", rows);
    expect(previewAgentImport({ source: "claude_code", files: [source] }).issues).toHaveLength(1);
    const session = previewAgentImport({ source: "claude_code", files: [source], branchLeafId: "end" }).sessions[0]!;
    expect(session.boundaries.filter(boundary => boundary.projection === "turn")).toHaveLength(1);
    expect(session.events.filter(event => event.usage?.invocationId === "invocation")).toHaveLength(1);
    expect(JSON.stringify(session.events)).not.toContain("other branch");
    expect(session.boundaries[0]!.coverage.process).toBe("retained");
  });
  // Failure story: numeric message IDs/seconds timestamps lose source identity, or tool-only messages are advertised as answers.
  it("preserves Hermes lineage and an unavailable answer for tool-only incomplete turns", () => {
    const session = previewAgentImport({ source: "hermes", files: [file("sessions.jsonl", [{ id: "child", lineage_session_ids: ["ancestor", "child"], messages: [
      { id: 1, role: "user", content: "request", timestamp: 1_759_276_800 },
      { id: 2, role: "assistant", content: null, tool_calls: [{ id: "tool", function: { name: "read", arguments: "{}" } }] },
    ] }])] }).sessions[0]!;
    expect(session.parentSessionId).toBe("ancestor");
    expect(session.events[0]!.id).toBe("1");
    expect(session.events[0]!.occurredAt).toBe(new Date(1_759_276_800_000).toISOString());
    expect(session.boundaries[0]!.coverage.answer).toBe(false);
    expect(resolveConnectedBoundary(session, session.boundaries[0]!.id).answer).toBeNull();
  });
  // Failure story: unmapped trajectory rows leak future tools into a cutoff or a changed bundle manifest bypasses admission.
  it("retains OpenClaw source process separately and rejects conflicting bundle identity", () => {
    const trajectory = [{ traceSchema: "openclaw-trajectory", schemaVersion: 1, sessionId: "claw", traceId: "trace", seq: 1, ts: at, type: "future_tool", payload: "unassigned evidence" }];
    const manifest = { traceSchema: "openclaw-trajectory", schemaVersion: 1, sessionId: "claw", traceId: "trace", leafId: "a", eventCount: 1 };
    const branch = { header: { id: "claw" }, leafId: "a", entries: [
      { id: "u", parentId: null, type: "message", timestamp: at, message: { role: "user", content: "request" } },
      { id: "a", parentId: "u", type: "message", timestamp: at, message: { role: "assistant", content: "answer" } },
    ] };
    const files = [{ path: "bundle/manifest.json", text: JSON.stringify(manifest) }, { path: "bundle/session-branch.json", text: JSON.stringify(branch) }, file("bundle/events.jsonl", trajectory)];
    const session = previewAgentImport({ source: "openclaw", files }).sessions[0]!;
    expect(session.unmappedEvents).toHaveLength(1);
    expect(JSON.stringify(resolveConnectedBoundary(session, session.boundaries[0]!.id))).not.toContain("unassigned evidence");
    expect(session.boundaries[0]!.coverage.process).toBe("absent");
    const wrong = structuredClone(files); wrong[0]!.text = JSON.stringify({ ...manifest, traceId: "other" });
    expect(previewAgentImport({ source: "openclaw", files: wrong }).issues).toHaveLength(1);
  });
  it("never partly admits malformed files or unsafe paths", () => {
    const invalid = { ...codex(), text: `${codex().text}\n{broken` };
    const result = previewAgentImport({ source: "codex", files: [invalid] });
    expect(result.sessions).toEqual([]); expect(result.issues).toHaveLength(1);
    expect(() => previewAgentImport({ source: "codex", files: [{ ...codex(), path: "../session.jsonl" }] })).toThrow("Unsafe");
  });
  it("counts real retry identities, deduplicates repeated receipts and preserves unknown token values", () => {
    const row = { requestId: "one", startedAt: at, provider: "provider", model: "model", mode: "work", status: "completed", source: "provider_usage", projectId: null,
      inputTokens: 10, cachedInputTokens: null, outputTokens: 3, totalTokens: null };
    const summary = summarizeConnectedInvocations([row, row, { ...row, requestId: "retry", status: "failed" }]);
    expect(summary.total).toMatchObject({ invocations: 2, inputTokens: 20, totalTokens: 0, missingTotal: 2, failures: 1 });
    expect(contentHash(summary.days[0])).toBe(contentHash({ key: at.slice(0, 10), ...summary.total }));
    expect(() => summarizeConnectedInvocations([row, { ...row, inputTokens: 11 }])).toThrow("connected_usage_receipt_conflict");
  });
});
