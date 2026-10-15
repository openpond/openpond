import { z } from "zod";

const PrepareSchema = z.object({ baseProfileId: z.string().trim().min(1).max(191) }).strict();
const RetireSchema = z.object({
  poolId: z.string().trim().min(1).max(191),
  reason: z.string().trim().min(3).max(512),
}).strict();
const PoolSchema = z.object({
  id: z.string().min(1),
  baseProfileId: z.string().min(1),
  provider: z.string().min(1),
  state: z.string().min(1),
  workersMin: z.number().int().nonnegative(),
  workersMax: z.number().int().nonnegative(),
}).passthrough();

/** Reuses hosted account, workspace, origin and transport checks. Preparing a
 * pool is a capacity operation; listing never prepares or wakes one. */
export async function runHostedServingCommand(input: {
  action: string;
  target: string | undefined;
  baseUrl: string;
  headers: Headers;
  request: typeof fetch;
  readInput(): Promise<unknown>;
  confirmed: boolean;
}): Promise<unknown> {
  let path = "/v1/model-adapters/serving-pools";
  let body: string | undefined;
  let expectedPoolId: string | undefined;
  let expectedBaseProfileId: string | undefined;
  if (input.action === "hosted-serving-pools") {
    if (input.target) throw new Error("hosted-serving-pools does not accept an identifier.");
  } else if (input.action === "hosted-base-serving-prepare") {
    if (!input.confirmed) throw new Error("Preparing serving capacity requires --yes. Inference is a separate operation.");
    const request = PrepareSchema.parse(await input.readInput());
    expectedBaseProfileId = request.baseProfileId;
    body = JSON.stringify(request);
  } else if (input.action === "hosted-serving-pool-retire") {
    if (!input.confirmed) throw new Error("Retiring serving capacity requires --yes.");
    const { poolId, reason } = RetireSchema.parse(await input.readInput());
    expectedPoolId = poolId;
    path += `/${encodeURIComponent(poolId)}/retire`;
    body = JSON.stringify({ reason });
  } else {
    throw new Error(`Unknown serving operation: ${input.action}`);
  }
  const headers = new Headers(input.headers);
  headers.set("accept", "application/json");
  if (body) headers.set("content-type", "application/json");
  const response = await input.request(new URL(path, input.baseUrl), {
    method: body ? "POST" : "GET", headers, body,
  });
  if (!response.ok) {
    throw new Error(`Hosted serving request failed (${response.status}). Inspect hosted-serving-pools before retrying a capacity change.`);
  }
  const value: unknown = await response.json();
  if (!body) return z.object({ pools: z.array(PoolSchema) }).parse(value);
  const result = z.object({ pool: PoolSchema }).parse(value);
  if ((expectedPoolId && result.pool.id !== expectedPoolId) ||
    (expectedBaseProfileId && result.pool.baseProfileId !== expectedBaseProfileId)) {
    throw new Error("Serving response identity mismatch. Inspect hosted-serving-pools before retrying.");
  }
  return result;
}
