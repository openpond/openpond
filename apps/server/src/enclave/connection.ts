import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readCredential, readCredentials, writeCredential, deleteCredential } from "@openpond/persistence";
import { EnclaveHealthSchema, EnclaveReplySchema, EnclavePromptSchema, type UrlModel, type UrlModelInspection } from "@openpond/contracts/enclave";
import { EnclaveError, normalizeModelEndpoint, remoteJson } from "./remote-json.js";
export { EnclaveError } from "./remote-json.js";

const PREFIX = "url-model:";
const ModelSchema = z.object({
  providerName: z.string().trim().min(1).max(100).default("Models from URL"),
  name: z.string().trim().min(1).max(100), endpoint: z.string(), model: z.string().trim().min(1).max(300),
  protocol: z.enum(["openai", "tvc"]), token: z.string().max(4096).regex(/^[\x21-\x7e]*$/),
});
const InspectSchema = z.object({ endpoint: z.string(), token: ModelSchema.shape.token.default("") }).strict();
const SaveSchema = InspectSchema.extend({ name: ModelSchema.shape.name, providerName: ModelSchema.shape.providerName, model: ModelSchema.shape.model });
const IdSchema = z.object({ id: z.string().regex(/^url:[a-f0-9-]{36}$/) }).strict();
type StoredModel = z.infer<typeof ModelSchema>;
export type EnclaveAction = "list" | "inspect" | "save" | "remove" | "chat";
const storageId = (id: string) => `${PREFIX}${id.slice(4)}`;
const publicModel = (id: string, model: StoredModel): UrlModel => ({ id, name: model.name, providerName: model.providerName, endpoint: model.endpoint, model: model.model, protocol: model.protocol, hasToken: Boolean(model.token) });

export async function listUrlModels(home: string): Promise<UrlModel[]> {
  return Object.entries(await readCredentials<StoredModel>(home, PREFIX)).map(([id, record]) => publicModel(`url:${id.slice(PREFIX.length)}`, ModelSchema.parse(record.value)));
}
export async function resolveUrlModel(home: string, id: string): Promise<StoredModel> {
  if (!IdSchema.safeParse({ id }).success) throw new EnclaveError(400, "Select a saved URL model.");
  const record = await readCredential<StoredModel>(home, storageId(id));
  if (!record) throw new EnclaveError(409, "This model connection was removed. Add it again in Providers.");
  return ModelSchema.parse(record.value);
}

export function createEnclaveConnection(deps: { home: string; fetch?: typeof fetch }) {
  const active = new Map<string, AbortController>();
  async function inspect(input: z.infer<typeof InspectSchema>, signal?: AbortSignal): Promise<UrlModelInspection> {
    const endpoint = normalizeModelEndpoint(input.endpoint);
    const health = await remoteJson({ ...input, endpoint, path: "health", signal, fetch: deps.fetch }).catch((error) => {
      if (signal?.aborted) throw error;
      return null;
    });
    const enclave = EnclaveHealthSchema.safeParse(health);
    if (enclave.success) {
      // Invalid input authenticates the caller without starting a generation.
      await remoteJson({ ...input, endpoint, path: "chat", body: { prompt: "" }, expectedStatus: 400, signal, fetch: deps.fetch });
      return { protocol: "tvc", models: [enclave.data.model], contextTokens: enclave.data.contextTokens };
    }
    const result = await remoteJson({ ...input, endpoint, path: "models", signal, fetch: deps.fetch });
    const parsed = z.object({ data: z.array(z.object({ id: z.string().min(1).max(300) })).max(5000) }).safeParse(result);
    if (!parsed.success || !parsed.data.data.length) throw new EnclaveError(502, "No models were returned. Use the API base URL, such as https://host/v1.");
    return { protocol: "openai", models: [...new Set(parsed.data.data.map((model) => model.id))] };
  }
  return async (action: EnclaveAction, payload?: unknown, signal?: AbortSignal): Promise<unknown> => {
    signal?.throwIfAborted();
    if (action === "list") return { models: await listUrlModels(deps.home) };
    if (action === "inspect" || action === "save") {
      const parsed = (action === "save" ? SaveSchema : InspectSchema).safeParse(payload);
      if (!parsed.success) throw new EnclaveError(400, "Provide a valid endpoint, API key, model, and display name.");
      const inspection = await inspect(parsed.data, signal);
      if (action === "inspect") return inspection;
      const input = SaveSchema.parse(parsed.data);
      if (!inspection.models.includes(input.model)) throw new EnclaveError(400, "The selected model is no longer offered by this endpoint. Fetch models again.");
      signal?.throwIfAborted();
      const existingProvider = (await listUrlModels(deps.home)).find((saved) => saved.providerName.toLocaleLowerCase() === input.providerName.toLocaleLowerCase());
      const providerName = existingProvider?.providerName ?? input.providerName;
      const id = `url:${randomUUID()}`;
      await writeCredential(deps.home, storageId(id), { ...input, providerName, endpoint: normalizeModelEndpoint(input.endpoint), protocol: inspection.protocol }, null);
      return { models: await listUrlModels(deps.home) };
    }
    const id = IdSchema.safeParse(action === "chat" && payload && typeof payload === "object" ? { id: (payload as Record<string, unknown>).id } : payload);
    if (!id.success) throw new EnclaveError(400, "Select a saved model connection.");
    if (action === "remove") { active.get(id.data.id)?.abort(); await deleteCredential(deps.home, storageId(id.data.id)); return { models: await listUrlModels(deps.home) }; }
    if (active.has(id.data.id)) throw new EnclaveError(409, "This model is busy. Cancel its current turn or wait for it to finish.");
    const controller = new AbortController(); active.set(id.data.id, controller);
    const abort = () => controller.abort(); signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    try {
      const model = await resolveUrlModel(deps.home, id.data.id);
      if (model.protocol !== "tvc") throw new EnclaveError(400, "This model uses the OpenAI-compatible chat API.");
      const input = EnclavePromptSchema.safeParse({ prompt: (payload as Record<string, unknown>).prompt });
      if (!input.success) throw new EnclaveError(400, "Enter a text message of at most 1,024 UTF-8 bytes.");
      return EnclaveReplySchema.parse(await remoteJson({ ...model, path: "chat", body: input.data, signal: controller.signal, timeoutMs: 310_000, fetch: deps.fetch }));
    } finally { signal?.removeEventListener("abort", abort); active.delete(id.data.id); }
  };
}
