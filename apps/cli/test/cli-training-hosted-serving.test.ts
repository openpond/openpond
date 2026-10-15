import { createServer } from "node:http";
import { once } from "node:events";
import { expect, test } from "vitest";
import { runHostedServingCommand } from "../src/cli/training-hosted-serving";

// Failure story: an operator typo must not allocate/retire capacity before
// confirmation, or report success for a different returned serving resource.
test("serving capacity mutations require confirmation and matching resource identity", async () => {
  const requests: string[] = [];
  const pool = { id: "owned-pool", baseProfileId: "qwen3-8b-b968826d", provider: "runpod_vllm", state: "ready", workersMin: 0, workersMax: 1 };
  const server = createServer((request, response) => {
    requests.push(request.method!);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.method === "GET" ? { pools: [pool] } : { pool }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing listener");
  const input = {
    action: "hosted-serving-pools", target: undefined as string | undefined,
    baseUrl: `http://127.0.0.1:${address.port}`, headers: new Headers(),
    request: fetch, readInput: async (): Promise<unknown> => ({ baseProfileId: pool.baseProfileId }), confirmed: false,
  };
  try {
    expect(await runHostedServingCommand(input)).toEqual({ pools: [pool] });
    await expect(runHostedServingCommand({ ...input, action: "hosted-base-serving-prepare", target: "input.json" })).rejects.toThrow("requires --yes");
    await expect(runHostedServingCommand({ ...input, action: "hosted-serving-pool-retire", target: "input.json" })).rejects.toThrow("requires --yes");
    expect(requests).toEqual(["GET"]);
    await expect(runHostedServingCommand({ ...input, action: "hosted-base-serving-prepare", target: "input.json", confirmed: true, readInput: async () => ({ baseProfileId: "other-base" }) })).rejects.toThrow("identity mismatch");
    await expect(runHostedServingCommand({ ...input, action: "hosted-serving-pool-retire", target: "input.json", confirmed: true, readInput: async () => ({ poolId: "different-pool", reason: "Finished bounded evaluation" }) })).rejects.toThrow("identity mismatch");
    expect(await runHostedServingCommand({ ...input, action: "hosted-base-serving-prepare", target: "input.json", confirmed: true })).toEqual({ pool });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
