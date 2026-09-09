import { expect, test } from "vitest";
import { createPolicyHarnessContext } from "../src/training-policy-harness.js";

// Failure story: a hosted compiler must bind the frozen dependency revision,
// and must not label host-private source as a portable policy asset.
test("pins policy dependencies and rejects private dependencies", () => {
  const original = createPolicyHarnessContext({ sourceRelease: { id: "source", contentHash: "a".repeat(64) } });
  const revised = createPolicyHarnessContext({ sourceRelease: { id: "source", contentHash: "b".repeat(64) } });
  expect(revised.harnessRelease.contentHash).not.toBe(original.harnessRelease.contentHash);
  expect(original.harnessRelease.agentSnapshot).toEqual({ id: original.agentSnapshot.id, contentHash: original.agentSnapshot.contentHash });
  const privateAsset = { id: "private", path: "skills/private.md", contentHash: "c".repeat(64), sizeBytes: 4, mediaType: "text/markdown", visibility: "host_private" as const };
  expect(() => createPolicyHarnessContext({ sourceRelease: null, skills: [privateAsset] })).toThrow("policy-visible");
  expect(() => createPolicyHarnessContext({ sourceRelease: null, agents: [privateAsset] })).toThrow("policy-visible");
});
