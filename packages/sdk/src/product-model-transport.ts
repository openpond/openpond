import { z } from "zod";
import { readBoundedJsonResponse } from "./protocol.js";
import { boundProductModelResponse } from "./product-model-response.js";
import {
  ProductModelError, ProductModelRequestStatusSchema, ProductModelToolCallSchema, canonicalResponseModelId,
  productModelEndpoint, type ProductModelConnection, type ProductModelRequestIdentity,
  type ProductModelWireStatus,
} from "./product-model-wire.js";

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const RequestId = ProductModelRequestStatusSchema.shape.requestId;
type Budget = { signal: AbortSignal; until: number };
const unknown = (identity: ProductModelRequestIdentity, status = 0) =>
  new ProductModelError("model_outcome_unknown", status, true, identity.requestId, identity.clientRequestId);

/** One paid submission, followed only by authenticated reads of that operation.
 * The text API and optional AI SDK adapter share this transport without sharing
 * mutable per-call identity or converting tool calls into a text projection. */
export class ProductModelTransport {
  private readonly identities = new WeakMap<Response, ProductModelRequestIdentity>();
  private readonly endpoint: string;
  constructor(private readonly modelId: string, private readonly connection: ProductModelConnection) {
    this.endpoint = `${productModelEndpoint(connection.baseUrl!)}/chat/completions`;
  }
  identity(response: Response): ProductModelRequestIdentity {
    return this.identities.get(response) ?? {};
  }
  private budget(timeoutMs: number, signal?: AbortSignal | null): Budget {
    const timeout = AbortSignal.timeout(timeoutMs);
    return { until: Date.now() + timeoutMs, signal: signal ? AbortSignal.any([signal, timeout]) : timeout };
  }
  private headers(extra?: HeadersInit) {
    const headers = new Headers(extra);
    headers.delete("openpond-api-key");
    headers.set("Authorization", `Bearer ${this.connection.apiKey}`);
    // An optional provider's per-call headers cannot change its workspace.
    headers.delete("X-OpenPond-Team-Id");
    if (this.connection.teamId) headers.set("X-OpenPond-Team-Id", this.connection.teamId);
    return headers;
  }
  private async fetchResponse(url: string, init: RequestInit, budget: Budget, identity: ProductModelRequestIdentity) {
    let response: Response;
    let responseSignal = budget.signal;
    for (;;) {
      const remaining = budget.until - Date.now();
      if (budget.signal.aborted || remaining <= 0) throw unknown(identity);
      responseSignal = init.method === "GET"
        ? this.budget(Math.min(30_000, remaining), budget.signal).signal : budget.signal;
      try {
        response = await (this.connection.fetch ?? fetch)(url, {
          ...init, redirect: "error", signal: responseSignal,
        });
      } catch {
        throw unknown(identity);
      }
      // A throttled observation is still the same retained operation. Retry
      // only GET, within its original budget; never repeat the paid POST.
      if (init.method !== "GET" || response.status !== 429) break;
      const retryAfter = response.headers.get("retry-after");
      const numeric = retryAfter !== null && /^\d+(?:\.\d+)?$/.test(retryAfter.trim())
        ? Number(retryAfter) * 1000 : NaN;
      const supplied = Number.isFinite(numeric) ? numeric : retryAfter ? Date.parse(retryAfter) - Date.now() : NaN;
      const delay = Number.isFinite(supplied) ? Math.max(500, supplied) : 2_000;
      await response.body?.cancel().catch(() => {});
      if (delay >= budget.until - Date.now())
        throw new ProductModelError("model_status_unavailable", 429, true, identity.requestId, identity.clientRequestId);
      await waitForObservation(delay, budget.signal, identity);
    }
    const observedId = response.headers.get("x-openpond-request-id") ?? response.headers.get("x-request-id");
    // A generic HTTP trace header is not the retained operation identity.
    // Pending/status bodies bind their own validated ID to the submitted UUID.
    if (!identity.requestId && observedId && (init.method !== "GET" && response.status !== 202
      || RequestId.safeParse(observedId).success)) identity.requestId = observedId;
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new ProductModelError(init.method === "GET" ? "model_status_unavailable" : "model_request_rejected",
        response.status, response.status === 408 || response.status >= 500,
        identity.requestId, identity.clientRequestId);
    }
    const bounded = boundProductModelResponse(response, { signal: responseSignal, ...identity });
    this.identities.set(bounded, { ...identity });
    return bounded;
  }
  async request(body: string, options: {
    stream: boolean; signal?: AbortSignal | null; clientRequestId?: string; headers?: HeadersInit;
  }): Promise<Response> {
    if (new TextEncoder().encode(body).length > 1024 * 1024)
      throw new ProductModelError("payload_too_large", 0, false);
    const headers = this.headers(options.headers);
    const parsedId = z.uuid().safeParse(options.clientRequestId ?? headers.get("X-OpenPond-Client-Request-Id") ?? crypto.randomUUID());
    if (!parsedId.success) throw new ProductModelError("client_request_id_invalid", 0, false);
    const identity: ProductModelRequestIdentity = { clientRequestId: parsedId.data };
    headers.set("X-OpenPond-Client-Request-Id", parsedId.data);
    headers.delete("idempotency-key");
    headers.delete("x-request-id");
    headers.set("Content-Type", "application/json");
    headers.set("Accept", options.stream ? "text/event-stream" : "application/json");
    const budget = this.budget(this.connection.timeoutMs ?? 630_000, options.signal);
    const response = await this.fetchResponse(this.endpoint, { method: "POST", headers, body }, budget, identity);
    if (response.status !== 202) return response;
    const completion = await this.observePending(response, identity, budget);
    let terminal: Response;
    try { terminal = terminalResponse(completion, options.stream); }
    catch { throw new ProductModelError("model_response_invalid", 200, true, identity.requestId, identity.clientRequestId); }
    const bounded = boundProductModelResponse(terminal, { signal: budget.signal, ...identity });
    this.identities.set(bounded, { ...identity });
    return bounded;
  }
  private async parseStatus(response: Response, expected: ProductModelRequestIdentity, deadlineAt?: string) {
    let status: ProductModelWireStatus;
    try {
      status = ProductModelRequestStatusSchema.parse(await readBoundedJsonResponse(response, MAX_BODY_BYTES, "Model status"));
    } catch {
      throw new ProductModelError("model_response_invalid", response.status, true, expected.requestId, expected.clientRequestId);
    }
    if (status.modelId !== canonicalResponseModelId(this.modelId)
      || expected.requestId !== undefined && status.requestId !== expected.requestId
      || expected.clientRequestId !== undefined && status.clientRequestId !== expected.clientRequestId
      || deadlineAt !== undefined && status.deadlineAt !== deadlineAt)
      throw new ProductModelError("model_recovery_identity_changed", 409, true, expected.requestId, expected.clientRequestId);
    if (status.result && (status.state !== "completed" || status.failureCode !== null
      || status.result.id !== status.requestId || status.result.model !== status.modelId
      || status.result.choices.length !== 1 || status.result.choices[0]?.index !== 0
      || !status.result.choices[0]?.message || !status.result.choices[0]?.finish_reason))
      throw new ProductModelError("model_response_invalid", response.status, true, status.requestId, expected.clientRequestId);
    return status;
  }
  private async readStatus(suffix: string, expected: ProductModelRequestIdentity, budget: Budget, deadlineAt?: string) {
    const headers = this.headers();
    headers.set("Accept", "application/json");
    const response = await this.fetchResponse(`${this.endpoint}${suffix}`, { method: "GET", headers }, budget, expected);
    return this.parseStatus(response, expected, deadlineAt);
  }
  async inspectRequest(requestId: string) {
    const id = RequestId.parse(requestId);
    return this.readStatus(`/${encodeURIComponent(id)}`, { requestId: id }, this.budget(30_000));
  }
  async recover(clientRequestId: string) {
    const id = z.uuid().parse(clientRequestId);
    return this.readStatus(`?clientRequestId=${encodeURIComponent(id)}`, { clientRequestId: id }, this.budget(30_000));
  }
  private async observePending(response: Response, identity: ProductModelRequestIdentity, budget: Budget) {
    let status = await this.parseStatus(response, identity);
    identity.requestId = status.requestId;
    const deadlineAt = status.deadlineAt;
    const remaining = Math.min(budget.until, Date.parse(deadlineAt) + 30_000) - Date.now();
    if (remaining <= 0) throw unknown(identity, 202);
    const observation = this.budget(remaining, budget.signal);
    budget.until = observation.until;
    budget.signal = observation.signal;
    for (;;) {
      if (observation.signal.aborted) throw unknown(identity, 202);
      if (status.state === "completed" && status.result) return status.result;
      if (status.state === "completed" || status.state === "failed" || status.state === "cancelled")
        throw new ProductModelError(status.state === "completed" ? "model_result_not_retained" : "model_request_failed",
          200, false, identity.requestId, identity.clientRequestId);
      const delay = Math.min(observation.until - Date.now(), Math.max(500,
        Math.min(15_000, status.retryAt ? Date.parse(status.retryAt) - Date.now() : 2_000)));
      await waitForObservation(delay, observation.signal, identity);
      try {
        status = await this.readStatus(`/${encodeURIComponent(identity.requestId!)}`, identity,
          this.budget(Math.max(1, observation.until - Date.now()), observation.signal), deadlineAt);
      } catch (error) {
        if (error instanceof ProductModelError && ["model_recovery_identity_changed", "model_response_invalid"].includes(error.code)) throw error;
        throw unknown(identity, 202);
      }
    }
  }
  async cancelRequest(requestId: string) {
    const id = RequestId.parse(requestId);
    try {
      const response = await this.fetchResponse(`${this.endpoint}/${encodeURIComponent(id)}/cancel`,
        { method: "POST", headers: this.headers() }, this.budget(30_000), { requestId: id });
      await response.body?.cancel();
    } catch {
      throw new ProductModelError("model_cancel_pending", 0, true, id);
    }
  }
}

async function waitForObservation(delay: number, signal: AbortSignal, identity: ProductModelRequestIdentity) {
  if (signal.aborted || delay <= 0) throw unknown(identity, 202);
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(unknown(identity, 202)); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, delay);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

const ToolCalls = z.array(ProductModelToolCallSchema);
/** A retained result is complete, not a resumed native token stream. Emit its
 * exact payload as bounded deltas and one terminal marker without another POST. */
function terminalResponse(completion: NonNullable<ProductModelWireStatus["result"]>, stream: boolean) {
  const headers = { "x-openpond-request-id": completion.id, "cache-control": "private, no-store" };
  if (!stream) return Response.json(completion, { headers });
  const choice = completion.choices[0]!, message = choice.message!;
  const identity = { id: completion.id, model: completion.model, created: completion.created,
    system_fingerprint: completion.system_fingerprint };
  const frames: string[] = [];
  const emit = (delta: Record<string, unknown>) => frames.push(`data: ${JSON.stringify({ ...identity,
    choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  emit({ role: "assistant" });
  if (message.content) for (let offset = 0; offset < message.content.length; offset += 16_384)
    emit({ content: message.content.slice(offset, offset + 16_384) });
  if (message.tool_calls !== undefined && message.tool_calls !== null) {
    const tools = ToolCalls.parse(message.tool_calls);
    for (const [index, tool] of tools.entries()) {
      emit({ tool_calls: [{ ...tool, index, type: "function", function: { name: tool.function.name, arguments: "" } }] });
      for (let offset = 0; offset < tool.function.arguments.length; offset += 16_384)
        emit({ tool_calls: [{ index, function: { arguments: tool.function.arguments.slice(offset, offset + 16_384) } }] });
    }
  }
  frames.push(`data: ${JSON.stringify({ ...identity, openpond: completion.openpond, usage: completion.usage,
    choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }] })}\n\n`, "data: [DONE]\n\n");
  return new Response(frames.join(""), { headers: { ...headers, "content-type": "text/event-stream" } });
}
