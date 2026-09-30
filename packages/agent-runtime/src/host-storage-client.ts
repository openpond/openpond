import { HostStorageRequestSchema, type HostStorageRequest } from "./host-storage-protocol.js";
import { JsonRpcErrorSchema, JsonRpcSuccessSchema, type JsonRpcRequest } from "./protocol.js";

/** Correlated child requests while an ordinary turn/start response is pending. */
export class AgentHostStorageClient {
  readonly #pending = new Map<string, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
    maxResponseBytes: number;
  }>();
  #send: ((message: JsonRpcRequest) => Promise<void>) | null = null;
  #nextId = 1;

  bind(send: (message: JsonRpcRequest) => Promise<void>): void {
    if (this.#send) throw new Error("Host storage client is already bound.");
    this.#send = send;
  }

  async request(input: HostStorageRequest, timeoutMs = 15_000): Promise<unknown> {
    const params = HostStorageRequestSchema.parse(input);
    if (!this.#send) throw new Error("Host storage transport is unavailable.");
    if (this.#pending.size >= 32) throw new Error("Host storage request limit exceeded.");
    const id = `host-storage:${this.#nextId++}`;
    const message: JsonRpcRequest = { jsonrpc: "2.0", id, method: "host/storage", params };
    const experiment = params.operation === "experiment/policy" || params.operation === "experiment/environment";
    if (Buffer.byteLength(JSON.stringify(message)) > (experiment ? 8_388_608 : 256_000)) {
      throw new Error("Host storage request is too large.");
    }
    const response = new Promise<unknown>((resolve, reject) => {
      // Cold hosted sandbox provisioning can exceed the normal storage budget.
      // The sandbox adapter supplies its per-action limit; do not truncate it
      // to the generic 60-second storage cap before the host can respond.
      const capMs = params.operation === "sandbox/request" || experiment ? 300_000 : 60_000;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("Host storage request timed out."));
      }, Math.max(1, Math.min(capMs, timeoutMs)));
      this.#pending.set(id, { resolve, reject, timer,
        maxResponseBytes: params.operation === "experiment/environment" ? 1_600_000 : 1_000_000 });
    });
    try {
      await this.#send(message);
    } catch (error) {
      const pending = this.#pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.#pending.delete(id);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return response;
  }

  accept(value: unknown): boolean {
    const success = JsonRpcSuccessSchema.safeParse(value);
    const failure = success.success ? null : JsonRpcErrorSchema.safeParse(value);
    const response = success.success ? success.data : failure?.success ? failure.data : null;
    if (!response || typeof response.id !== "string" || !response.id.startsWith("host-storage:")) return false;
    const pending = this.#pending.get(response.id);
    if (!pending) return true;
    clearTimeout(pending.timer);
    this.#pending.delete(response.id);
    if (Buffer.byteLength(JSON.stringify(response)) > pending.maxResponseBytes) {
      pending.reject(new Error("Host storage response is too large."));
      return true;
    }
    if ("error" in response) pending.reject(new Error(`Host storage request failed: ${response.error.message}`));
    else pending.resolve(response.result);
    return true;
  }

  close(): void {
    this.#send = null;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Host storage transport closed."));
    }
    this.#pending.clear();
  }
}
