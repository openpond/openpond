import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { canonicalSha256 } from "../src/protocol.js";
import { parseAndVerifyTrainingModelServing } from "../src/training-model-serving.js";

// A failed quality evaluation must not block testing an exact saved checkpoint,
// while revocation, deletion and immutable source substitution must still fail.
it("verifies serving independently of evaluation while retaining withdrawal and identity fences", async () => {
  const fixture = JSON.parse(readFileSync(new URL("../fixtures/python-foundation/training-model-serving-http-workflow.json", import.meta.url), "utf8"));
  const expected = { modelProjectId: fixture.modelProjectId, ...fixture.query };
  for (const state of ["imported_unvalidated", "evaluating", "rejected"]) {
    const content = structuredClone(fixture.response);
    delete content.contentHash;
    content.registry.state = state;
    const verified = await parseAndVerifyTrainingModelServing({ ...content, contentHash: await canonicalSha256(content) }, expected);
    expect(verified.state).toBe("active");
    for (const mutation of ["revoked", "deleted", "source"] as const) {
      const changed = structuredClone(content);
      if (mutation === "source") changed.registry.source.artifact.contentHash = "f".repeat(64);
      else changed.registry[mutation] = true;
      await expect(parseAndVerifyTrainingModelServing({ ...changed, contentHash: await canonicalSha256(changed) }, expected))
        .rejects.toMatchObject({ code: "training_model_serving_mismatch" });
    }
  }
});
