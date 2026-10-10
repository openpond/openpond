import { z } from "zod";
import { CodexAppServerClient } from "@openpond/codex-provider";
import { ProviderModelSchema, type ProviderSettings, type CodexStatus } from "@openpond/contracts";

const ModelPage = z.object({
  data: z.array(z.object({
    model: z.string().trim().min(1), displayName: z.string().trim().min(1),
    hidden: z.boolean(), isDefault: z.boolean(),
    inputModalities: z.array(z.string()).default([]),
    supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })).default([]),
  })).max(500),
  nextCursor: z.string().nullable().optional(),
});
type Catalog = { models: ProviderSettings["modelCaches"][string]["models"]; defaultModel: string | null; error: string | null; fetchedAt: string };
const cache = new Map<string, { expires: number; value: Promise<Catalog> }>();

async function discover(binaryPath: string): Promise<Catalog> {
  const client = new CodexAppServerClient({ binaryPath });
  const timeout = setTimeout(() => { void client.stop(); }, 15_000);
  try {
    const models: Catalog["models"] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    let defaultModel: string | null = null;
    do {
      const page = ModelPage.parse(await client.listModels({ limit: 100, includeHidden: false, cursor }));
      for (const model of page.data) {
        if (model.hidden) continue;
        if (models.some(value => value.id === model.model)) throw new Error("Codex returned a duplicate model.");
        if (model.isDefault) defaultModel = model.model;
        const reasoningEfforts = model.supportedReasoningEfforts.map(value => value.reasoningEffort)
          .filter((value): value is "off" | "low" | "medium" | "high" | "xhigh" | "max" =>
            ["off", "low", "medium", "high", "xhigh", "max"].includes(value));
        models.push(ProviderModelSchema.parse({
          id: model.model, providerId: "codex", displayName: model.displayName, source: "provider",
          capabilities: { streaming: true, toolCalling: true, reasoning: true,
            reasoningEfforts, vision: model.inputModalities.includes("image") },
        }));
      }
      if (models.length > 500) throw new Error("Codex model catalog is too large.");
      cursor = page.nextCursor ?? null;
      if (cursor && cursors.has(cursor)) throw new Error("Codex returned a repeated model cursor.");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return { models, defaultModel, error: null, fetchedAt: new Date().toISOString() };
  } catch {
    return { models: [], defaultModel: null, error: "Unable to load models from the installed Codex agent. Refresh to retry.", fetchedAt: new Date().toISOString() };
  } finally { clearTimeout(timeout); await client.stop(); }
}

/** Advertise installed agent choices rather than a stale hosted/curated model list. */
export async function withCodexModelCatalog(settings: ProviderSettings, codex: CodexStatus, force = false) {
  const status = settings.statuses.codex;
  if (!status?.enabled || !codex.available || codex.authHealth !== "signed_in") return settings;
  const binaryPath = settings.providers.codex?.binaryPath ?? codex.binaryPath ?? "codex";
  let entry = cache.get(binaryPath);
  if (!entry || (force || entry.expires <= Date.now()) && entry.expires !== Infinity) {
    entry = { expires: Infinity, value: discover(binaryPath) };
    cache.set(binaryPath, entry);
    const current = entry;
    void entry.value.then(value => { current.expires = Date.now() + (value.error ? 30_000 : 300_000); });
  }
  const catalog = await entry.value;
  settings.modelCaches.codex = { providerId: "codex", models: catalog.models,
    source: "provider", lastError: catalog.error, fetchedAt: catalog.fetchedAt };
  status.modelIds = catalog.models.map(model => model.id);
  const configured = settings.providers.codex?.defaultModel;
  status.defaultModel = configured && status.modelIds.includes(configured) ? configured : catalog.defaultModel;
  if (catalog.error) { status.available = false; status.lastError = catalog.error; }
  return settings;
}
