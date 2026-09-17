import { z } from "zod";
import { contentHash, type HarnessRelease, type ToolDeclaration } from "@openpond/harness";
import type { Session, Turn, ChatProvider, ConnectedAppConnectionLike, CreateHostedSavedWorkRequest } from "@openpond/contracts";
import type { ModelToolDefinition, ModelToolExecutionContext } from "../openpond/model-tool-registry.js";
import type { WebSearchExecutor } from "../openpond/web-search.js";
import type { ConnectedAppToolExecutor } from "../openpond/connected-app-tool-registry.js";
import type { OpenPondDatasetBuilderAction } from "../openpond/capability-tool-registry.js";

export type AppServerToolBinding = {
  name: string;
  version: string;
  inputSchema: z.ZodType<Record<string, unknown>>;
  execute(context: ModelToolExecutionContext): Promise<Record<string, unknown>>;
};

export type AppServerHarnessToolContext = {
  session: Session;
  turn: Turn;
  harness: HarnessRelease | null;
  declarations: readonly ToolDeclaration[];
  signal: AbortSignal;
};

/** Deployment authority, never sourced from a prompt, Harness or turn metadata. */
export type AppServerEmbeddingOptions = {
  allowedTools: readonly string[];
  resolveTools?(context: AppServerHarnessToolContext): Promise<readonly AppServerToolBinding[]>;
  /** Called for every admitted tool invocation, including built-ins and follow-up turns. */
  authorizeTool(context: ModelToolExecutionContext & { name: string }): Promise<void>;
  maxToolOutputBytes?: number;
};

export type AppServerServiceOptions = {
  webSearch?: false | WebSearchExecutor;
  scheduling?: false | ((input: CreateHostedSavedWorkRequest) => Promise<Record<string, unknown>>);
  connectedApps?: false | {
    execute: ConnectedAppToolExecutor;
    list: (input: { teamId?: string; status?: "active" | "revoked" | "error" | "all" }) => Promise<{
      teamId: string | null; connections: ConnectedAppConnectionLike[];
    }>;
  };
  tasksets?: false | ((input: {
    session: Session; turnId: string; callId: string; signal: AbortSignal;
    provider: ChatProvider; model: string; action: OpenPondDatasetBuilderAction; payload: Record<string, unknown>;
  }) => Promise<unknown>);
  projectActions?: false | ((payload: unknown) => Promise<unknown>);
  profileActions?: false;
  backgroundReview?: boolean;
};

export type AppServerWorkLifecycle = {
  workInputsForSession?(session: Session): Promise<ReadonlyArray<{
    localPath?: string; storageName?: string; bytes?: Uint8Array; sha256?: string; sizeBytes?: number;
  }>>;
  finalizeWorkTurn?(input: {
    session: Session; turnId: string; outcome: "completed" | "failed" | "interrupted";
  }): Promise<Session>;
};

export type ResolveAppServerModelTools = (input: AppServerHarnessToolContext & {
  tools: ModelToolDefinition[];
}) => Promise<ModelToolDefinition[]>;

export function createEmbeddingToolResolver(
  options: AppServerEmbeddingOptions,
  recordBindings: (turnId: string, bindings: Array<{ name: string; version: string }>) => Promise<void>,
): ResolveAppServerModelTools {
  const allowed = new Set(options.allowedTools);
  const maxBytes = options.maxToolOutputBytes ?? 64 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid embedded tool output limit.");
  if (typeof options.authorizeTool !== "function") throw new Error("Embedded Work requires a tool authorizer.");
  return async (input) => {
    input.signal.throwIfAborted();
    const declarations = new Map<string, ToolDeclaration>();
    for (const declaration of input.declarations) {
      if (contentHash(declaration.inputSchema) !== declaration.inputSchemaHash) {
        throw new Error(`Harness tool schema hash mismatch: ${declaration.name}`);
      }
      const existing = declarations.get(declaration.name);
      if (existing && contentHash(existing) !== contentHash(declaration)) {
        throw new Error(`Conflicting Harness tool declarations: ${declaration.name}`);
      }
      declarations.set(declaration.name, declaration);
      if (!allowed.has(declaration.name)) throw new Error(`Harness tool is not permitted: ${declaration.name}`);
    }
    const builtIns = new Map(input.tools.map(tool => [tool.name, tool]));
    const bindings = await options.resolveTools?.({ ...input, declarations: [...declarations.values()] }) ?? [];
    input.signal.throwIfAborted();
    const custom = new Map<string, ModelToolDefinition>();
    const receipt: Array<{ name: string; version: string }> = [];
    for (const binding of bindings) {
      const declaration = declarations.get(binding.name);
      if (!declaration) throw new Error(`Undeclared embedded tool: ${binding.name}`);
      if (builtIns.has(binding.name) || custom.has(binding.name)) throw new Error(`Duplicate embedded tool: ${binding.name}`);
      if (!binding.version.trim()) throw new Error(`Embedded tool version is required: ${binding.name}`);
      const schema = z.toJSONSchema(binding.inputSchema, { target: "draft-7" });
      if (contentHash(schema) !== declaration.inputSchemaHash) {
        throw new Error(`Embedded tool schema mismatch: ${binding.name}`);
      }
      receipt.push({ name: binding.name, version: binding.version });
      custom.set(binding.name, {
        name: binding.name,
        description: declaration.description,
        parameters: declaration.inputSchema,
        execute: async (context) => {
          const signal = AbortSignal.any([context.signal, AbortSignal.timeout(declaration.timeoutMs)]);
          signal.throwIfAborted();
          const args = binding.inputSchema.parse(context.args);
          const data = await withToolAbort(signal, () => binding.execute({ ...context, args, signal }));
          signal.throwIfAborted();
          const contentText = JSON.stringify(data);
          if (Buffer.byteLength(contentText, "utf8") > maxBytes) throw new Error(`Embedded tool output exceeds limit: ${binding.name}`);
          return { toolCallId: context.callId, name: binding.name, ok: true, contentText, data };
        },
      });
    }
    for (const declaration of declarations.values()) {
      const implementation = custom.get(declaration.name) ?? builtIns.get(declaration.name);
      if (!implementation) throw new Error(`Missing Harness tool implementation: ${declaration.name}`);
      if (contentHash(implementation.parameters) !== declaration.inputSchemaHash) {
        throw new Error(`Harness tool implementation schema mismatch: ${declaration.name}`);
      }
    }
    await recordBindings(input.turn.id, receipt);
    return [...input.tools, ...custom.values()].filter(tool => allowed.has(tool.name)).map(tool => ({
      ...tool,
      execute: async (context) => {
        context.signal.throwIfAborted();
        await options.authorizeTool({ ...context, name: tool.name });
        context.signal.throwIfAborted();
        return tool.execute(context);
      },
    }));
  };
}

async function withToolAbort<T>(signal: AbortSignal, execute: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(execute), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
