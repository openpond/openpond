import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { expect, test } from "vitest";
import { createTrainingClient, type ModificationRecordingRequest } from "openpond-sdk/training";
import { createHttpRequestHandler, type HttpRouteDeps } from "../api/http-routes.js";
import { SqliteStore } from "../store/store.js";
import { createLocalModificationRecordings } from "./modification-recordings.js";

// Failure story: recording/retrying a harness capture could duplicate records,
// leak another account's evidence, or open bytes that differ from the retained
// result. Exercise the real authenticated API and reopened SQLite together.
test("retains immutable external observations through HTTP with replay, custody and account isolation", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "openpond-modification-recording-"));
  let store = new SqliteStore(home), actorId = "owner", apiBaseUrl = "https://api.example.test", substitute = false;
  const owner = () => createLocalModificationRecordings({ store, teamId: async () => "team", actorId: async () => actorId,
    resolveAccess: async () => ({ apiBaseUrl }) });
  let service = owner(), forbiddenDispatches = 0;
  const server = createServer(createHttpRequestHandler({ host: "127.0.0.1", getActualPort: () => (server.address() as AddressInfo).port,
    token: "observation-test-capability", version: "test", logger: { info() {}, warn() {}, error() {} },
    modificationRecordings: { record: (raw: unknown) => service.record(raw), list: (raw: unknown) => service.list(raw),
      read: async (id: string, teamId: string) => { const value = await service.read(id, teamId);
        if (substitute) value.document.result.captures[0]!.after += 1; return value; } },
    trainingPayload: async () => { forbiddenDispatches++; throw new Error("Recording cannot dispatch training or provider work"); },
  } as unknown as HttpRouteDeps));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const document = JSON.parse(await readFile(path.resolve("packages/sdk/fixtures/python-foundation/activation-reference-workflow.json"), "utf8"));
    const command: ModificationRecordingRequest = { schemaVersion: "openpond.modificationRecordingRequest.v1", teamId: "team", operationId: "retain-cpu-reference",
      name: "Synthetic CPU observation", projectId: "project", method: "neuron_steering", request: document.request, result: document.result };
    expect((await fetch(`${baseUrl}/v1/modification-recordings?teamId=team`)).status).toBe(401);
    const client = createTrainingClient({ baseUrl, headers: { authorization: "Bearer observation-test-capability" } });
    const [first, replay] = await Promise.all([client.recordModificationObservation(command), client.recordModificationObservation(command)]);
    expect(replay).toEqual(first);
    expect(first).toMatchObject({ custody: "local", provenance: "external_observation", measurementAttestation: "unattested", counts: { prompts: 2, variants: 8, outcomes: 16, captures: 560 } });
    await expect(client.recordModificationObservation({ ...command, name: "Changed under the same operation" })).rejects.toMatchObject({ status: 409, code: "modification_recording_operation_conflict" });
    await expect(client.recordModificationObservation({ ...command, operationId: "invalid", method: "inspect_activations" })).rejects.toMatchObject({ code: "modification_recording_method_mismatch" });
    const second = await client.recordModificationObservation({ ...command, operationId: "second-observation" });
    const page = await client.modificationRecordings({ teamId: "team", projectId: "project", limit: 1 });
    expect(page.items).toHaveLength(1); expect(page.nextCursor).toBeTruthy();
    const next = await client.modificationRecordings({ teamId: "team", projectId: "project", limit: 1, cursor: page.nextCursor! });
    expect(new Set([...page.items, ...next.items].map(row => row.id))).toEqual(new Set([first.id, second.id]));
    expect(next.nextCursor).toBeNull();
    await expect(client.modificationRecordings({ teamId: "team", projectId: "another-project", cursor: page.nextCursor! })).rejects.toMatchObject({ status: 400, code: "modification_recording_cursor_invalid" });
    expect((await client.modificationRecordings({ teamId: "team", search: "CPU" })).items).toHaveLength(2);
    await store.close(); store = new SqliteStore(home); service = owner();
    expect((await client.modificationRecording(first.id, { teamId: "team" })).document).toEqual(document);
    expect(await client.recordModificationObservation(command)).toEqual(first);
    actorId = "another-owner";
    expect((await client.modificationRecordings({ teamId: "team" })).items).toEqual([]);
    await expect(client.modificationRecording(first.id, { teamId: "team" })).rejects.toMatchObject({ status: 404 });
    const other = await client.recordModificationObservation(command); expect(other.id).not.toBe(first.id);
    actorId = "owner"; apiBaseUrl = "https://other-api.example.test";
    expect((await client.modificationRecordings({ teamId: "team" })).items).toEqual([]);
    await expect(client.modificationRecording(first.id, { teamId: "team" })).rejects.toMatchObject({ status: 404 });
    apiBaseUrl = "https://api.example.test"; substitute = true;
    await expect(client.modificationRecording(first.id, { teamId: "team" })).rejects.toMatchObject({ code: "activation_reference_result_mismatch" });
    substitute = false;
    expect((await client.modificationRecording(first.id, { teamId: "team" })).document).toEqual(document);
    expect(forbiddenDispatches).toBe(0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await store.close(); await rm(home, { recursive: true, force: true });
  }
});
