import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { ProviderSettingsSchema, SessionSchema, type LocalDatasetRecord } from "@openpond/contracts";
import { SqliteStore } from "../store/store.js";
import { createChatResourceRuntime } from "./chat-resource-runtime.js";

// Failure story: asking what is selected must not enumerate unrelated resources,
// depend on hosted catalogs or lose the exact Dataset pin when catalogs fail.
test("focused chat context reads its exact selection without consulting resource catalogs", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "openpond-chat-focus-"));
  const store = new SqliteStore(home);
  const unused = vi.fn(async (): Promise<never> => { throw new Error("Unrelated service unavailable"); });
  const state = vi.fn(async () => ({ settings: ProviderSettingsSchema.parse({}), secrets: { version: 1 as const, providers: {} } }));
  type Deps = Parameters<typeof createChatResourceRuntime>[0];
  let runtime: Awaited<ReturnType<typeof createChatResourceRuntime>> | undefined;
  try {
    await store.claimLocalExperimentOwner("focus-owner");
    const now = "2026-11-08T00:00:00.000Z";
    await store.insertSessionAtFront(SessionSchema.parse({ id: "chat", provider: "codex", title: "Focus", appId: null, appName: null,
      cwd: null, codexThreadId: null, pinned: false, archived: false, order: 0, createdAt: now, updatedAt: now, status: "idle" }));
    runtime = await createChatResourceRuntime({ store, home, ownerId: "focus-owner", state, access: unused, append: async () => {},
      imports: {} as Deps["imports"], visuals: {} as Deps["visuals"],
      teamExperiments: { request: unused, read: unused, result: unused }, resolveInvocation: unused });
    const selected = await runtime.datasets.request({ action: "create", operationId: "selected", payload: { name: "Chosen examples" } }) as { record: LocalDatasetRecord };
    await runtime.datasets.request({ action: "create", operationId: "unrelated", payload: { name: "UNRELATED_DATASET_CANARY" } });
    const listing = vi.spyOn(store, "listLocalDatasetListings").mockImplementation(unused);
    const experiments = vi.spyOn(runtime.experiments.service, "list").mockImplementation(unused);
    const context = () => runtime!.request("dataset", { action: "context", payload: { sessionId: "chat", focusOnly: true } });
    expect(await context()).toMatchObject({ focus: { dataset: null, experiment: null }, selection: null, graders: [] });
    const id = selected.record.workspace.draft.id;
    await runtime.request("dataset", { action: "set_focus", payload: { sessionId: "chat", kind: "dataset", id, revision: 1 } });
    const result = await context();
    expect(result).toMatchObject({ focus: { dataset: { id, revision: 1 } }, selection: { target: { kind: "dataset", id, revision: 1 } } });
    expect(result).not.toHaveProperty("datasets");
    expect(result).not.toHaveProperty("experiments");
    expect(JSON.stringify(result)).not.toContain("UNRELATED_DATASET_CANARY");
    expect(listing).not.toHaveBeenCalled();
    expect(experiments).not.toHaveBeenCalled();
    expect(unused).not.toHaveBeenCalled();
    expect(state).not.toHaveBeenCalled();
  } finally {
    await runtime?.close();
    await store.close();
    await rm(home, { recursive: true, force: true });
  }
});
