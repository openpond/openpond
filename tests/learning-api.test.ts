import { createServer } from "node:http";
import { once } from "node:events";
import { expect, test } from "vitest";
import { OpenPondLearningClient } from "../packages/sdk/src/learning";
import { learningRef, TaskEvidenceSchema, TaskGradeRunSchema } from "@openpond/evals/learning";
import { createHttpRequestHandler, type HttpRouteDeps } from "../apps/server/src/api/http-routes";
import { createLocalLearningRuntime } from "../apps/server/src/training/learning-runtime";
import { SqliteLearningStore } from "../apps/server/src/store/store-learning";
import { withTempDirectory } from "./helpers/temp-directory";
import { learningContext, learningFixture } from "./helpers/learning-fixtures";

// Regression: a portable SDK request must reach authenticated Desktop storage and durable jobs unchanged.
test("public learning SDK crosses the authenticated HTTP boundary with retries, validation, conflicts and real grading", async () => {
  await withTempDirectory("openpond-learning-api-", async (home) => {
    const store = new SqliteLearningStore(home);
    const runtime = createLocalLearningRuntime(store);
    const fixture = await learningFixture(store.learningRepository());
    const server = createServer(createHttpRequestHandler({
      host: "127.0.0.1", getActualPort: () => 0, token: "test-local-owner", version: "test", runtimeVersion: "test",
      logger: { info() {}, warn() {}, error() {} },
      trainingPayload: async (action: string, payload: unknown) => action === "learning_command" ? runtime.command(payload) : runtime.read(payload),
    } as unknown as HttpRouteDeps));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test listener did not bind.");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const sdk = new OpenPondLearningClient({ baseUrl, apiKey: "test-local-owner", scope: learningContext.scope });
    try {
      const denied = new OpenPondLearningClient({ baseUrl, apiKey: "wrong", scope: learningContext.scope });
      await expect(denied.list("source")).rejects.toMatchObject({ status: 401 });
      const first = await sdk.submitExample(fixture.example);
      expect(await sdk.submitExample(fixture.example)).toEqual(first);
      await expect(sdk.submitExample({ ...fixture.example, input: { question: "Conflicting retry" } })).rejects.toMatchObject({ status: 409, code: "learning_idempotency_conflict" });
      await expect(sdk.get("evidence", "missing")).rejects.toMatchObject({ status: 404, code: "learning_resource_not_found" });
      const evidence = TaskEvidenceSchema.parse(first.resources[0]);
      const grade = TaskGradeRunSchema.parse((await sdk.command({ operationId: "grade-http", action: "queue_grade", evidence: learningRef(evidence), target: "observed", proposedTarget: null, timeoutMs: 30_000, maximumSpendUsd: 0 })).resources[0]);
      await runtime.drain();
      expect(await sdk.get("grade", grade.id)).toMatchObject({ status: "completed", composition: { training: { passed: false } } });
      expect((await sdk.list("evidence", { parentId: fixture.source.id, limit: 1 })).items).toEqual([evidence]);
      const { contentHash: _hash, ...content } = fixture.source;
      await expect(sdk.command({ action: "publish", operationId: "stale-source", kind: "source", expectedRevision: 0, content: { ...content, name: "Stale overwrite" } })).rejects.toMatchObject({ status: 409, code: "learning_revision_conflict", details: { currentRevision: 1 } });
      expect(await sdk.get("source", fixture.source.id)).toEqual(fixture.source);
      const forgedActor = await fetch(`${baseUrl}/v1/learning/commands`, { method: "POST", headers: { Authorization: "Bearer test-local-owner", "Content-Type": "application/json" }, body: JSON.stringify({ scope: learningContext.scope, actor: { id: "forged" }, command: { action: "submit_example", operationId: "forged", example: fixture.example } }) });
      expect(forgedActor.status).toBe(400);
      // Raw producers must hit the complexity bound before recursive Zod parsing.
      let nested: unknown = "value";
      for (let depth = 0; depth < 60; depth++) nested = { nested };
      const tooDeep = await fetch(`${baseUrl}/v1/learning/commands`, { method: "POST", headers: { Authorization: "Bearer test-local-owner", "Content-Type": "application/json" }, body: JSON.stringify({ scope: learningContext.scope, command: { action: "submit_example", operationId: "deep", example: { ...fixture.example, input: nested } } }) });
      expect(tooDeep.status).toBe(400);
      expect(await tooDeep.json()).toMatchObject({ code: "learning_json_invalid" });
      expect(await sdk.get("source", fixture.source.id)).toEqual(fixture.source);
    } finally {
      await runtime.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await store.close();
    }
  });
});
