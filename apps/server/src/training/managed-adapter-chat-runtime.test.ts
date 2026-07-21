import { describe, expect, test, vi } from "vitest";
import type { ModelArtifactLineage, ModelBinding } from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";
import { createManagedAdapterChatRuntime } from "./managed-adapter-chat-runtime.js";
import {
  managedBindingLogicalModelName,
  managedBindingProjectionVersion,
} from "./managed-adapter-sync-service.js";

describe("managed adapter chat runtime", () => {
  test("routes only ready active bindings to the personalized gateway", async () => {
    const binding = modelBinding();
    const lineage = modelLineage();
    const store = {
      getActiveModelBinding: vi.fn(async () => binding),
      getModelArtifactLineage: vi.fn(async () => lineage),
    } as unknown as SqliteStore;
    const streamChat = vi.fn(async function* () {
      yield { text: "managed" };
    });
    const runtime = createManagedAdapterChatRuntime({
      store,
      client: { streamChat } as never,
    });
    const modelId = "binding:profile-1:chat_manual:target-1";
    expect(await runtime.appliesTo(modelId)).toBe(true);
    const deltas = [];
    for await (const delta of runtime.stream({
      modelId,
      messages: [{ role: "user", content: "hello" }],
      requestId: "request-1",
      signal: new AbortController().signal,
    })) {
      deltas.push(delta);
    }
    expect(deltas).toEqual([{ text: "managed" }]);
    expect(streamChat).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: "team_qa",
        logicalModelName: managedBindingLogicalModelName(binding),
      }),
    );
  });

  test("uses persisted monotonic binding projection versions", () => {
    expect(managedBindingProjectionVersion(modelBinding())).toBe(3);
    expect(
      managedBindingLogicalModelName(modelBinding()),
    ).toMatch(/^trained-[a-f0-9]{32}$/);
  });

  test.each([
    {
      state: "pending" as const,
      artifactState: null,
      deploymentState: null,
    },
    {
      state: "imported" as const,
      artifactState: "promotable" as const,
      deploymentState: "provisioning" as const,
    },
    {
      state: "failed" as const,
      artifactState: "promotable" as const,
      deploymentState: "failed" as const,
    },
  ])(
    "claims a managed $state projection but fails closed before provider submission",
    async ({ state, artifactState, deploymentState }) => {
      const binding = modelBinding();
      const lineage = modelLineage();
      lineage.managedServing = {
        ...lineage.managedServing!,
        state,
        canonicalArtifactState: artifactState,
        canonicalDeploymentState: deploymentState,
        canonicalDeploymentId:
          deploymentState === null ? null : "deployment-1",
      };
      const store = {
        getActiveModelBinding: vi.fn(async () => binding),
        getModelArtifactLineage: vi.fn(async () => lineage),
      } as unknown as SqliteStore;
      const streamChat = vi.fn(async function* () {
        yield { text: "must-not-run" };
      });
      const runtime = createManagedAdapterChatRuntime({
        store,
        client: { streamChat } as never,
      });
      const modelId = "binding:profile-1:chat_manual:target-1";

      expect(await runtime.appliesTo(modelId)).toBe(true);
      await expect(
        collect(runtime.stream({
          modelId,
          messages: [{ role: "user", content: "hello" }],
          requestId: "request-not-ready",
          signal: new AbortController().signal,
        })),
      ).rejects.toThrow("not ready on managed serving");
      expect(streamChat).not.toHaveBeenCalled();
    },
  );

  test("does not claim a binding that has never entered managed serving", async () => {
    const binding = modelBinding();
    const lineage = modelLineage();
    lineage.managedServing = null;
    const runtime = createManagedAdapterChatRuntime({
      store: {
        getActiveModelBinding: vi.fn(async () => binding),
        getModelArtifactLineage: vi.fn(async () => lineage),
      } as unknown as SqliteStore,
      client: { streamChat: vi.fn() } as never,
    });

    expect(
      await runtime.appliesTo("binding:profile-1:chat_manual:target-1"),
    ).toBe(false);
  });
});

async function collect<T>(
  iterable: AsyncIterable<T>,
): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function modelBinding(): ModelBinding {
  return {
    schemaVersion: "openpond.modelBinding.v1",
    id: "binding-1",
    profileId: "profile-1",
    role: "chat_manual",
    roleTargetId: "target-1",
    modelArtifactLineageId: "lineage-1",
    tasksetId: "taskset-1",
    evaluationArtifactId: "evaluation-1",
    status: "active",
    priorBindingId: null,
    rollbackTargetBindingId: null,
    promotedBy: "user-1",
    promotedAt: "2026-07-19T12:00:00.000Z",
    rolledBackAt: null,
    metadata: { managedProjectionVersion: 3 },
  };
}

function modelLineage(): ModelArtifactLineage {
  return {
    schemaVersion: "openpond.modelArtifactLineage.v1",
    id: "lineage-1",
    modelId: null,
    artifactId: "source-artifact-1",
    jobId: "job-1",
    tasksetId: "taskset-1",
    tasksetHash: "a".repeat(64),
    graderHash: "b".repeat(64),
    planHash: "c".repeat(64),
    bundleHash: "d".repeat(64),
    recipeHash: "e".repeat(64),
    workerVersion: "worker-1",
    trainerVersion: "trainer-1",
    importedAt: "2026-07-19T11:00:00.000Z",
    frozenEvaluationArtifactId: "evaluation-1",
    promotable: true,
    pinned: true,
    status: "imported",
    rejectedAt: null,
    rejectionReason: null,
    chatConfiguration: {
      schemaVersion: "openpond.localModelChatConfiguration.v1",
      profile: "efficient",
      systemPromptMode: "lean",
      customSystemPrompt: null,
      contextWindowTokens: 1024,
      maxOutputTokens: 64,
      temperature: 0,
      repetitionPenalty: 1.1,
      noRepeatNgramSize: 3,
      compaction: "when_needed",
      keepWarmSeconds: 300,
      updatedAt: null,
    },
    managedServing: {
      schemaVersion: "openpond.managedAdapterServingProjection.v1",
      teamId: "team_qa",
      source: "openpond_fireworks",
      sourceRef: "lineage-1",
      canonicalArtifactId: "artifact-1",
      canonicalArtifactState: "promotable",
      canonicalDeploymentId: "deployment-1",
      canonicalDeploymentState: "ready",
      state: "ready",
      publishedAt: "2026-07-19T11:30:00.000Z",
      lastSyncedAt: "2026-07-19T12:00:00.000Z",
      lastError: null,
    },
  };
}
