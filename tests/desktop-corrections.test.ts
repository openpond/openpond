import { expect, test } from "vitest";
import { DesktopCorrectionsStateSchema } from "@openpond/contracts";
import { createHostedEvaluationWorkspace } from "../apps/server/src/training/hosted-evaluation-workspace.js";

// Failure story: the desktop must delegate defaults/preferences to the hosted
// API, never create resources, and never display another account's destination.
test("desktop relays account Corrections through the SDK and fences account changes", async () => {
  let actorId = "owner-a", wrongWorkspace = false, missing = false;
  let onRead: (() => void) | undefined;
  const states = new Map(["owner-a", "owner-b"].map(owner => [owner, {
    scopeKey: (owner === "owner-a" ? "a" : "b").repeat(64), teamId: "workspace", actorId: owner,
    defaultDatasetId: `corrections-${owner}`, selectionRevision: 0, destinationError: null,
    modelId: `untrained-${owner}`, graderDraftId: `grader-${owner}`, graderState: "unavailable",
    dataset: { id: `corrections-${owner}`, name: "Corrections", revision: 1 },
  }]));
  const paths: string[] = [];
  const transport: typeof fetch = async (resource, init) => {
    const url = new URL(String(resource));
    const method = init?.method ?? "GET";
    paths.push(`${method} ${url.pathname}`);
    const owner = new Headers(init?.headers).get("Authorization")!.replace(/^Bearer /, "");
    const state = states.get(owner)!;
    expect(url.pathname).toBe("/v1/dataset-workspaces/defaults/corrections");
    expect(["GET", "POST"]).toContain(method);
    if (missing) return Response.json({ code: "dataset_not_found" }, { status: 404 });
    if (method === "POST") {
      const body = JSON.parse(String(init?.body));
      if (body.datasetId !== `custom-${owner}` && body.datasetId !== state.defaultDatasetId)
        return Response.json({ code: "dataset_not_found" }, { status: 404 });
      if (state.selectionRevision !== body.expectedSelectionRevision)
        return Response.json({ code: "dataset_revision_conflict" }, { status: 409 });
      state.selectionRevision++;
      state.dataset = { id: body.datasetId, name: "Reviewed issues", revision: 1 };
    } else onRead?.();
    return Response.json(wrongWorkspace ? { ...state, teamId: "foreign-workspace" } : state);
  };
  const access = async () => ({ teamId: "workspace", apiBaseUrl: "https://api.example.test", token: actorId });
  const service = () => createHostedEvaluationWorkspace({
    store: {} as Parameters<typeof createHostedEvaluationWorkspace>[0]["store"],
    resolveAccess: access, resolveActorId: async () => actorId, fetch: transport,
  });
  let relay = service();
  const request = (value: Record<string, unknown>) => relay.request({ teamId: "workspace", projectId: null,
    operation: "desktopCorrections", value });
  const first = DesktopCorrectionsStateSchema.parse(await request({ actorId }));
  expect(first.dataset?.id).toBe("corrections-owner-a");
  expect(first.graderState).toBe("unavailable"); // Judge setup does not prevent logging.
  const selected = DesktopCorrectionsStateSchema.parse(await request({ actorId, action: "select", datasetId: "custom-owner-a", expectedSelectionRevision: 0 }));
  expect(selected.dataset?.id).toBe("custom-owner-a");
  relay = service(); // A fresh desktop instance reads the same hosted preference.
  expect(DesktopCorrectionsStateSchema.parse(await request({ actorId })).dataset?.id).toBe("custom-owner-a");
  await expect(request({ actorId, action: "select", datasetId: first.defaultDatasetId, expectedSelectionRevision: 0 })).rejects.toThrow();
  actorId = "owner-b";
  expect(DesktopCorrectionsStateSchema.parse(await request({ actorId })).dataset?.id).toBe("corrections-owner-b");
  await expect(request({ actorId, action: "select", datasetId: "custom-owner-a", expectedSelectionRevision: 0 })).rejects.toThrow();
  await expect(request({ actorId: "owner-a" })).rejects.toThrow(/account changed/);
  wrongWorkspace = true;
  await expect(request({ actorId })).rejects.toThrow(/workspace/);
  wrongWorkspace = false;
  missing = true;
  await expect(request({ actorId })).rejects.toThrow();
  missing = false;
  onRead = () => { actorId = "owner-a"; };
  await expect(request({ actorId: "owner-b" })).rejects.toThrow(/account or workspace changed/);
  expect(paths.every(path => path.startsWith("GET ") || path.startsWith("POST "))).toBe(true);
});
