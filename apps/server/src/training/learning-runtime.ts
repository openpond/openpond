import { randomUUID } from "node:crypto";
import {
  createLearningService, createTaskGradeWorker,
  LearningCommandRequestSchema, LearningReadRequestSchema, type TaskGradeExecutor,
  assertLearningRequestJson,
} from "@openpond/evals/learning";
import type { SqliteLearningStore } from "../store/store-learning.js";
import { createLocalTaskGradeExecutor } from "./learning-grade-executor.js";

export function createLocalLearningRuntime(store: SqliteLearningStore, options: {
  executor?: TaskGradeExecutor;
  onError?: (error: unknown) => void;
} = {}) {
  const repository = store.learningRepository();
  const service = createLearningService(repository);
  const worker = createTaskGradeWorker(repository, options.executor ?? createLocalTaskGradeExecutor(repository), { workerId: `local-${randomUUID()}` });
  let interval: ReturnType<typeof setInterval> | null = null;
  let draining: Promise<void> | null = null;
  let closed = false;
  // The authenticated local server token owns this installation. Request bodies cannot supply a reviewer identity.
  const context = (scope: string) => ({ scope, actor: { id: `local-user:${scope}`, role: "reviewer" as const } });
  async function drain() {
    if (closed) return;
    if (draining) return draining;
    draining = (async () => {
      for (const scope of await store.listLearningScopes()) {
        if (closed) break;
        await worker.drain(scope);
      }
    })().finally(() => { draining = null; });
    return draining;
  }
  function wake() { void drain().catch(options.onError ?? ((error) => console.error("Local learning worker failed", error))); }
  return {
    async command(raw: unknown) {
      assertLearningRequestJson(raw);
      const request = LearningCommandRequestSchema.parse(raw);
      const result = await service.command(context(request.scope), request.command);
      if (request.command.action === "cancel_grade") worker.requestCancellation(request.scope, request.command.gradeId);
      wake();
      return result;
    },
    async read(raw: unknown) {
      assertLearningRequestJson(raw);
      const request = LearningReadRequestSchema.parse(raw);
      if (request.action === "inspect_evidence") return service.inspectEvidence(context(request.scope), request.evidence);
      if (request.action === "get") return service.get(context(request.scope), request.kind, request.id, request.revision);
      const { action: _action, scope, kind, ...query } = request;
      return service.list(context(scope), kind, query);
    },
    start() {
      if (closed) throw new Error("learning_runtime_closed");
      if (interval) return;
      interval = setInterval(wake, 5_000);
      interval.unref();
      wake();
    },
    async close() {
      closed = true;
      if (interval) clearInterval(interval);
      interval = null;
      await draining;
    },
    drain,
  };
}
