import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { contentHash } from "@openpond/harness";
import { SqliteStore } from "../apps/server/src/store/store";
import { decisionScoreFixture } from "./helpers/decision-score-fixture";

const mock = vi.hoisted(() => ({
  access: { apiBaseUrl: "https://api.example.test", teamId: "team", actorId: "actor", token: "fixture" },
  serving: vi.fn(), score: vi.fn(),
  version: null as unknown,
}));
vi.mock("../apps/server/src/training/managed-saved-model-access.js", () => ({
  configuredAccess: async () => mock.access,
  identity: (access: typeof mock.access) => ({ teamId: access.teamId, actorId: access.actorId, apiOrigin: access.apiBaseUrl }),
  accountFence: async () => {},
  clientFor: () => ({ decisionModelServing: mock.serving, scoreDecisionModel: mock.score }),
}));
vi.mock("../apps/server/src/training/managed-saved-model-discovery.js", () => ({
  listManagedSavedModelVersions: async () => [{ project: { id: "model", name: "Decision" },
    version: mock.version }],
}));
import { acknowledgeManagedDecisionChatScore, listManagedDecisionChatModels, scoreManagedDecisionChat } from "../apps/server/src/training/managed-decision-chat";

// A lost scoring response must not become a second paid operation after restart.
// Exercise the real device journal/cache and account fences; the mock upstream
// supplies synthetic protocol metadata, never native inference qualification.
test("Decision chat retains one uncertain score across concurrency and restart without crossing accounts", async () => {
  const fixture = await decisionScoreFixture();
  mock.version = fixture.version;
  const home = await mkdtemp(path.join(tmpdir(), "openpond-decision-chat-"));
  let store = new SqliteStore(home);
  const versionHash = fixture.version.contentHash;
  const ready = { state: "active", availability: { state: "qualified", runtimeHash: "b".repeat(64) },
    version: { contentHash: versionHash, ownerUserId: "actor" },
    control: { actorId: "actor", versionHash, desiredState: "active", phase: "active", poolId: "pool", binding: { id: "binding", revision: 1 } },
    bindings: [{ id: "binding", revision: 1, poolId: "pool", versionHash, modelId: "decision:model:model" }],
    pools: [{ id: "pool", state: "ready", endpointRecorded: true, workerImageDigest: `sha256:${"c".repeat(64)}` }],
  };
  mock.serving.mockResolvedValue({ ...ready, state: "inactive" });
  mock.score.mockImplementation(async () => { throw new Error("Response lost after upstream acceptance"); });
  const payload = { input: { state: { signal: "blue" }, questions: [{ id: "route", description: "Which route?", type: "choice" as const,
    choices: [{ value: "left", description: "Left route" }, { value: "right", description: "Right route" }] }] },
    limits: { maximumPromptTokens: 512, maximumForwardTokenWork: 2048, maximumDurationSeconds: 30 } };
  try {
    const [model] = await listManagedDecisionChatModels(store, "team");
    expect(model?.id).toBe(fixture.modelId);
    expect(mock.serving).not.toHaveBeenCalled();
    const input = { store, modelId: model!.id, selectedTeamId: "team", requestId: "chat-request", payload, signal: new AbortController().signal };
    await expect(scoreManagedDecisionChat({ ...input, selectedTeamId: "another-team" })).rejects.toThrow("original workspace");
    mock.access.actorId = "other-actor";
    await expect(scoreManagedDecisionChat(input)).rejects.toThrow("original account");
    mock.access.actorId = "actor";
    await expect(scoreManagedDecisionChat(input)).rejects.toThrow("Enable qualified serving");
    expect(mock.score).not.toHaveBeenCalled();
    mock.serving.mockResolvedValue(ready);
    const concurrent = await Promise.allSettled([scoreManagedDecisionChat(input), scoreManagedDecisionChat(input)]);
    expect(concurrent.every(row => row.status === "rejected")).toBe(true);
    expect(mock.score).toHaveBeenCalledTimes(1);
    const originalId = mock.score.mock.calls[0]![1].requestId;
    const scopeHash = contentHash({ actorId: "actor", apiOrigin: mock.access.apiBaseUrl, teamId: "team", projectId: null });
    const pending = await store.pendingEvaluationOperations({ scopeHash, action: "training-decision-score" });
    expect(pending.items).toHaveLength(1);
    expect(pending.items[0]!.command).toMatchObject({ request: { requestId: originalId, input: payload.input } });
    const changed = { ...payload, input: { ...payload.input, state: { signal: "red" } } };
    await expect(scoreManagedDecisionChat({ ...input, payload: changed })).rejects.toThrow("without changing its input");
    await store.close();
    store = new SqliteStore(home);
    await expect(scoreManagedDecisionChat({ ...input, store })).rejects.toThrow("Response lost");
    expect(mock.score).toHaveBeenCalledTimes(2);
    expect(mock.score.mock.calls[1]![1].requestId).toBe(originalId);
    mock.serving.mockResolvedValue({ ...ready, state: "inactive" });
    await expect(scoreManagedDecisionChat({ ...input, store, requestId: "retry-as-new-turn" })).rejects.toThrow("Response lost");
    expect(mock.score).toHaveBeenCalledTimes(3);
    expect(mock.score.mock.calls[2]![1].requestId).toBe(originalId);
    mock.serving.mockResolvedValue(ready);
    await expect(scoreManagedDecisionChat({ ...input, store, requestId: "another-chat-request", payload: changed })).rejects.toThrow("Recover the original uncertain operation");
    expect(mock.score).toHaveBeenCalledTimes(3);
    mock.score.mockImplementation(async (_model, request) => fixture.receipt(request));
    const recovered = await scoreManagedDecisionChat({ ...input, store });
    expect(recovered.requestId).toBe(originalId);
    expect((await store.pendingEvaluationOperations({ scopeHash, action: "training-decision-score" })).items).toHaveLength(1);
    const delivered = await scoreManagedDecisionChat({ ...input, store, requestId: "recover-undelivered" });
    expect(delivered.requestId).toBe(originalId);
    expect(mock.score).toHaveBeenCalledTimes(5);
    await acknowledgeManagedDecisionChatScore({ store, modelId: model!.id, requestId: "recover-undelivered", receipt: delivered });
    expect((await store.pendingEvaluationOperations({ scopeHash, action: "training-decision-score" })).items).toHaveLength(0);
    await store.close(); store = new SqliteStore(home);
    expect((await scoreManagedDecisionChat({ ...input, store })).contentHash).toBe(recovered.contentHash);
    expect(mock.score).toHaveBeenCalledTimes(5);
  } finally {
    mock.access.actorId = "actor";
    await store.close();
    await rm(home, { recursive: true, force: true });
  }
});
