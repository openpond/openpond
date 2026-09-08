import { expect, it } from "vitest";
import { createTasksetDraft, createTasksetDraftFile, OpenPondTasksetDraftClient } from "../src/taskset-drafts.js";

// A hosted response must not substitute a foreign draft or stale revision, and
// transport errors must never cause an automatic second mutation.
it("scopes draft requests and rejects mismatched revisions, bytes and owners", async () => {
  const draft = createTasksetDraft({ profileId: "team", id: "draft", modelScope: { modelId: "model", expectedModelRevision: 1 } });
  const readback = { schemaVersion: "openpond.tasksetDraftReadback.v1", teamId: "team", modelId: "model", draft, workspaceHash: "a".repeat(64), projectEtag: "b".repeat(64) };
  const calls: Array<{ url: string; method: string | undefined }> = [];
  let payload: unknown = readback;
  let status = 200;
  const client = new OpenPondTasksetDraftClient({ baseUrl: "https://example.invalid", apiKey: "test", teamId: "team", fetch: async (url, init) => {
    expect(new Headers(init?.headers).get("X-OpenPond-Team-Id")).toBe("team");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test");
    expect(init?.redirect).toBe("error");
    calls.push({ url: String(url), method: init?.method });
    return Response.json(payload, { status });
  } });
  expect((await client.get("model", "draft")).draft).toEqual(draft);
  expect(calls[0]?.url).toBe("https://example.invalid/v1/models/model/taskset-drafts/draft");
  payload = { ...readback, draft: { ...draft, id: "foreign-draft" } };
  await expect(client.get("model", "draft")).rejects.toMatchObject({ code: "draft_response_mismatch" });
  payload = readback;
  await expect(client.save("model", { expectedDraftRevision: 1, draft })).rejects.toMatchObject({ code: "draft_response_mismatch" });
  payload = { ...readback, draft: { ...draft, revision: 2 } };
  expect((await client.save("model", { expectedDraftRevision: 1, draft })).draft.revision).toBe(2);
  const file = createTasksetDraftFile("graders/private code.js", new TextEncoder().encode("private source"));
  payload = { schemaVersion: "openpond.tasksetDraftFileReadback.v1", teamId: "team", modelId: "model", draftId: "draft", draftRevision: 2, file };
  expect((await client.readFile("model", "draft", file.path)).file).toEqual(file);
  expect(calls.at(-1)!.url).toContain("path=graders%2Fprivate%20code.js");
  payload = { schemaVersion: "openpond.tasksetDraftFileReadback.v1", teamId: "team", modelId: "model", draftId: "draft", draftRevision: 2, file: { ...file, contentHash: "f".repeat(64) } };
  await expect(client.readFile("model", "draft", file.path)).rejects.toMatchObject({ code: "draft_response_mismatch" });
  payload = { ...readback, teamId: "foreign-team" };
  await expect(client.get("model", "draft")).rejects.toThrow();
  payload = { code: "draft_conflict", message: "Changed" };
  status = 409;
  const before = calls.length;
  await expect(client.save("model", { expectedDraftRevision: 1, draft })).rejects.toMatchObject({ status: 409, code: "draft_conflict" });
  expect(calls.length).toBe(before + 1);
  const beforeInvalid = calls.length;
  await expect(client.readFile("model", "draft", "../outside")).rejects.toThrow();
  expect(calls.length).toBe(beforeInvalid);
});
