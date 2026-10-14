import { expect, test, vi } from "vitest";
import { resolveStructuredOutput, sha256 } from "@openpond/harness";
import type { OpenPondSandboxClient } from "@openpond/cloud/sandbox/client";
import { OpenPondWorkClient } from "../src/work.js";

// Protect the SDK boundary: an invalid direct file cannot bypass submission,
// and a corrected structured submission must reach output collection intact.
test("Work corrects rejected output before accepting a structured artifact", async () => {
  const bytes = Buffer.from(JSON.stringify({ type: "object", properties: { count: { type: "integer", minimum: 1 } }, required: ["count"], additionalProperties: false }));
  let contents = '{"count":"wrong"}';
  let listed = false;
  let staged = "";
  const record = { id: "structured", state: "running" };
  const fake = {
    get: vi.fn().mockResolvedValue(record),
    mkdir: vi.fn(),
    listFiles: vi.fn(async () => {
      if (!listed) { listed = true; return { files: [] }; }
      return { files: [{ path: "outputs/observations.json", type: "file", sizeBytes: contents.length, updatedAt: "2026-10-13T00:00:00Z", isBinary: false, previewable: true }] };
    }),
    downloadFileResponse: vi.fn(async () => ({ file: { contentsBase64: Buffer.from(contents).toString("base64"), truncated: false } })),
    uploadFileBase64: vi.fn(async (_id, _path, base64) => { staged = Buffer.from(base64, "base64").toString(); }),
    exec: vi.fn(async () => { contents = staged; return { command: { exitCode: 0 } }; }),
  };
  let turn = 0;
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    expect(request.tools.some((tool: any) => tool.function.name === "work_submit_output_1")).toBe(true);
    turn++;
    if (turn === 2) {
      expect(JSON.stringify(request.messages)).toContain("structured_output_invalid");
      return Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: "correct", type: "function", function: { name: "work_submit_output_1", arguments: '{"count":2}' } }] } }] });
    }
    return Response.json({ choices: [{ message: { content: "Done" } }] });
  });
  try {
    const work = new OpenPondWorkClient({ apiKey: "test", apiBaseUrl: "https://example.invalid", chatApiBaseUrl: "https://example.invalid", customModel: true, sandboxes: fake as unknown as OpenPondSandboxClient });
    const result = await work.run({ prompt: "Record observations", sandboxId: "structured", maxSteps: 4, requiredOutputs: [{ path: "observations.json", mediaType: "application/json", submissionMode: "structured_json", structuredOutput: resolveStructuredOutput(bytes, sha256(bytes)) }] });
    expect(turn).toBe(3);
    expect(JSON.parse(contents)).toEqual({ count: 2 });
    expect(result.outputs[0]?.validation?.artifactHash).toBe(sha256(Buffer.from(contents)));
  } finally { fetch.mockRestore(); }
});
