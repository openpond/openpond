import { afterEach, expect, test, vi } from "vitest";
import { OpenPondLearningClient } from "openpond-sdk/learning";
import type { SqliteStore } from "../store/store.js";
import { createModelLearningHostingService } from "./model-learning-hosting.js";

const hosted = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("openpond-sdk/model-projects", async importOriginal => ({ ...await importOriginal<object>(), createModelProjectsClient: () => hosted }));
afterEach(() => vi.restoreAllMocks());

// A sidebar count must never read a different profile/team or confuse the
// hosted storage ID with the portable Model identity used by learning policies.
test("task queue reads verify ownership before selecting model or workspace scope", async () => {
  const local = { id: "portable-a", profileId: "profile-a", hosted: { projectId: "hosted-a", teamId: "team-a", apiOrigin: "https://api.example.test" } };
  const store = { getModelProject: vi.fn(async () => local) } as unknown as SqliteStore;
  const access = { apiBaseUrl: "https://api.example.test", token: "test-only", teamId: "team-a" };
  const resolveAccess = vi.fn(async () => access);
  const service = createModelLearningHostingService({ store, resolveAccess });
  const inspect = vi.spyOn(OpenPondLearningClient.prototype, "inspectTaskQueue").mockImplementation(async modelProjectId => ({ modelProjectId: modelProjectId ?? null, inspectedAt: "2026-09-11T00:00:00.000Z", pendingTrainingCount: 3, issues: [] }));
  const scope = { modelId: "portable-a", profileId: "profile-a", workspace: false };
  await expect(service.taskQueue({ ...scope, profileId: "other-profile" })).rejects.toThrow("Profile");
  expect(resolveAccess).not.toHaveBeenCalled();
  access.teamId = "other-team";
  await expect(service.taskQueue(scope)).rejects.toThrow("workspace differs");
  expect(inspect).not.toHaveBeenCalled();
  access.teamId = "team-a";
  hosted.get.mockResolvedValue({ project: { id: "hosted-a", portableProjectId: "other-model" } });
  await expect(service.taskQueue(scope)).rejects.toThrow("identity differs");
  expect(inspect).not.toHaveBeenCalled();
  hosted.get.mockResolvedValue({ project: { id: "hosted-a", portableProjectId: "portable-a" } });
  await expect(service.taskQueue(scope)).resolves.toMatchObject({ modelProjectId: "portable-a", pendingTrainingCount: 3 });
  expect(inspect).toHaveBeenLastCalledWith("portable-a");
  await expect(service.taskQueue({ ...scope, workspace: true })).resolves.toMatchObject({ modelProjectId: null, pendingTrainingCount: 3 });
  expect(inspect).toHaveBeenLastCalledWith(null);
});
