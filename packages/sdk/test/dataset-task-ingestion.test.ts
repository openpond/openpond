import { createServer } from "node:http";
import { once } from "node:events";
import { expect, test } from "vitest";
import { OpenPondClient, createTaskAdder } from "../src/index";

// A repeated source key must stay unchanged; foreign receipts must be rejected.
test("flat and bound task submission preserve retry identity and check the destination", async () => {
  const requests: unknown[] = [];
  let wrongWorkspace = false;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    expect(request.url).toBe("/v1/dataset-workspaces/dataset%2Fone/tasks");
    expect(request.headers["x-openpond-team-id"]).toBe("workspace");
    expect(request.headers.authorization).toBe("Bearer test-key");
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        schemaVersion: "openpond.datasetTaskReceipt.v1",
        teamId: wrongWorkspace ? "other" : "workspace",
        datasetId: "dataset/one",
        operationId: body.operationId,
        taskId: "task-one",
        receivedAt: "2026-11-06T16:00:00Z",
        revision: 2,
        state: "saved",
        trainingUseAuthorized: false,
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No HTTP listener");
  const config = {
    baseUrl: "http://127.0.0.1:" + address.port,
    apiKey: "test-key",
    teamId: "workspace",
  };
  try {
    const client = new OpenPondClient({ ...config, datasetId: "dataset/one" });
    const task = { name: "Expired token", input: { error: "Token expired" } };
    const first = await client.addTask("dataset/one", task, { idempotencyKey: "source-event" });
    const addTask = createTaskAdder({ ...config, datasetId: "dataset/one" });
    expect(await addTask(task, { idempotencyKey: "source-event" })).toEqual(first);
    expect(requests[1]).toEqual(requests[0]);
    expect(first.trainingUseAuthorized).toBe(false);
    expect(await client.addTask({ ...task, id: "source-event" })).toEqual(first);
    expect(await client.dataset("dataset/one").addTask({ ...task, id: "source-event" })).toEqual(
      first,
    );
    expect(requests[2]).toEqual(requests[0]);
    expect(requests[3]).toEqual(requests[0]);
    await expect(
      client.addTask({ ...task, id: "other" }, { idempotencyKey: "source-event" }),
    ).rejects.toThrow("same source event");
    const productionDefault = new OpenPondClient({
      apiKey: "test-key", teamId: "workspace", datasetId: "dataset/one",
      fetch: async (input, init) => {
        expect(String(input)).toBe("https://api.openpond.ai/v1/dataset-workspaces/dataset%2Fone/tasks");
        return fetch(config.baseUrl + new URL(String(input)).pathname, init);
      },
    });
    expect(await productionDefault.addTask({ ...task, id: "source-event" })).toEqual(first);
    wrongWorkspace = true;
    await expect(addTask(task)).rejects.toThrow("receipt identity mismatch");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
