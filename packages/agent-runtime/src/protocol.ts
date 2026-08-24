import { z } from "zod";

export const AGENT_PROTOCOL_VERSION = "2026-08-06";

export const AGENT_RPC_METHODS = [
  "initialize",
  "initialized",
  "runtime/capabilities",
  "thread/start",
  "thread/resume",
  "thread/read",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
  "approval/resolve",
  "userInput/resolve",
  "harness/inspect",
  "harness/proposalReview",
  "harness/review",
  "harness/acceptEvaluationReview",
  "harness/materializeEvaluationTaskset",
  "harness/runEvaluationBaseline",
  "harness/validate",
  "harness/backgroundReview",
  "harness/diff",
  "harness/rollback",
] as const;

export type AgentRpcMethod = (typeof AGENT_RPC_METHODS)[number];
export type JsonRpcId = string | number;

export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  method: z.string().trim().min(1),
  params: z.unknown().optional(),
}).strict();

export const JsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string().trim().min(1),
  params: z.unknown().optional(),
}).strict();

export const JsonRpcSuccessSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  result: z.unknown(),
}).strict();

export const JsonRpcErrorSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]),
  error: z.object({
    code: z.number().int(),
    message: z.string(),
    data: z.unknown().optional(),
  }).strict(),
}).strict();

export const AgentProtocolEnvelopeSchema = z.union([
  JsonRpcRequestSchema,
  JsonRpcNotificationSchema,
  JsonRpcSuccessSchema,
  JsonRpcErrorSchema,
]);

export const InitializeParamsSchema = z.object({
  protocolVersion: z.string().trim().min(1),
  client: z.object({
    name: z.string().trim().min(1),
    version: z.string().trim().min(1),
  }).strict(),
  capabilities: z.record(z.string(), z.unknown()).default({}),
}).strict();

export type AgentProtocolCapabilities = {
  protocolVersion: string;
  placement: "local" | "hosted_chat" | "hosted_work" | "development";
  methods: AgentRpcMethod[];
  features: Record<string, boolean>;
  connectedAppProviders: string[];
  tools: Array<Record<string, unknown>>;
  toolCatalogHash: string;
};

export type AgentRuntimeHost = {
  capabilities(params?: unknown): Promise<AgentProtocolCapabilities>;
  threadStart(params: unknown): Promise<unknown>;
  threadResume(params: unknown): Promise<unknown>;
  threadRead(params: unknown): Promise<unknown>;
  turnStart(params: unknown): Promise<unknown>;
  turnSteer(params: unknown): Promise<unknown>;
  turnInterrupt(params: unknown): Promise<unknown>;
  approvalResolve(params: unknown): Promise<unknown>;
  userInputResolve(params: unknown): Promise<unknown>;
  harnessInspect(params: unknown): Promise<unknown>;
  harnessProposalReview(params: unknown): Promise<unknown>;
  harnessReview(params: unknown): Promise<unknown>;
  harnessAcceptEvaluationReview(params: unknown): Promise<unknown>;
  harnessMaterializeEvaluationTaskset(params: unknown): Promise<unknown>;
  harnessRunEvaluationBaseline(params: unknown): Promise<unknown>;
  harnessValidate(params: unknown): Promise<unknown>;
  harnessBackgroundReview(params: unknown): Promise<unknown>;
  harnessDiff(params: unknown): Promise<unknown>;
  harnessRollback(params: unknown): Promise<unknown>;
  subscribe?(listener: (notification: JsonRpcNotification) => void): () => void;
};

export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;
export type JsonRpcNotification = z.infer<typeof JsonRpcNotificationSchema>;
export type JsonRpcSuccess = z.infer<typeof JsonRpcSuccessSchema>;
export type JsonRpcError = z.infer<typeof JsonRpcErrorSchema>;
export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

export class AgentJsonRpcDispatcher {
  readonly #host: AgentRuntimeHost;
  #initializeParams: z.infer<typeof InitializeParamsSchema> | null = null;
  #initialized = false;

  constructor(host: AgentRuntimeHost) {
    this.#host = host;
  }

  get initialized(): boolean {
    return this.#initialized;
  }

  async handle(value: unknown): Promise<JsonRpcResponse | null> {
    const notification = JsonRpcNotificationSchema.safeParse(value);
    if (notification.success && !("id" in (value as object))) {
      if (notification.data.method === "initialized") {
        if (!this.#initializeParams) throw new JsonRpcDispatchError(-32002, "initialize must be called first");
        this.#initialized = true;
      }
      return null;
    }
    const parsed = JsonRpcRequestSchema.safeParse(value);
    if (!parsed.success) return jsonRpcError(null, -32600, "Invalid Request", parsed.error.flatten());
    const request = parsed.data;
    try {
      const result = await this.#dispatch(request.method, request.params);
      return { jsonrpc: "2.0", id: request.id, result };
    } catch (error) {
      const dispatchError = error instanceof JsonRpcDispatchError
        ? error
        : new JsonRpcDispatchError(-32603, error instanceof Error ? error.message : String(error));
      return jsonRpcError(request.id, dispatchError.code, dispatchError.message, dispatchError.data);
    }
  }

  async #dispatch(method: string, params: unknown): Promise<unknown> {
    if (method === "initialize") {
      const input = InitializeParamsSchema.parse(params);
      if (input.protocolVersion !== AGENT_PROTOCOL_VERSION) {
        throw new JsonRpcDispatchError(-32001, "Incompatible agent protocol version", {
          requested: input.protocolVersion,
          supported: AGENT_PROTOCOL_VERSION,
        });
      }
      this.#initializeParams = input;
      return {
        protocolVersion: AGENT_PROTOCOL_VERSION,
        server: { name: "openpond-app-server", version: "1" },
        capabilities: await this.#host.capabilities(),
      };
    }
    if (!this.#initialized) throw new JsonRpcDispatchError(-32002, "initialized notification is required");
    switch (method) {
      case "runtime/capabilities": return this.#host.capabilities(params);
      case "thread/start": return this.#host.threadStart(params);
      case "thread/resume": return this.#host.threadResume(params);
      case "thread/read": return this.#host.threadRead(params);
      case "turn/start": return this.#host.turnStart(params);
      case "turn/steer": return this.#host.turnSteer(params);
      case "turn/interrupt": return this.#host.turnInterrupt(params);
      case "approval/resolve": return this.#host.approvalResolve(params);
      case "userInput/resolve": return this.#host.userInputResolve(params);
      case "harness/inspect": return this.#host.harnessInspect(params);
      case "harness/proposalReview": return this.#host.harnessProposalReview(params);
      case "harness/review": return this.#host.harnessReview(params);
      case "harness/acceptEvaluationReview": return this.#host.harnessAcceptEvaluationReview(params);
      case "harness/materializeEvaluationTaskset": return this.#host.harnessMaterializeEvaluationTaskset(params);
      case "harness/runEvaluationBaseline": return this.#host.harnessRunEvaluationBaseline(params);
      case "harness/validate": return this.#host.harnessValidate(params);
      case "harness/backgroundReview": return this.#host.harnessBackgroundReview(params);
      case "harness/diff": return this.#host.harnessDiff(params);
      case "harness/rollback": return this.#host.harnessRollback(params);
      default: throw new JsonRpcDispatchError(-32601, `Method not found: ${method}`);
    }
  }
}

class JsonRpcDispatchError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
  }
}

function jsonRpcError(id: JsonRpcId | null, code: number, message: string, data?: unknown): JsonRpcError {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}
