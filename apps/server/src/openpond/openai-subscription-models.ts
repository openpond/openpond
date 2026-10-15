import { z } from "zod";
import { ProviderModelSchema, type ProviderModel } from "@openpond/contracts/providers";

// The subscription endpoint advertises Codex models, not Platform /v1/models.
const CatalogSchema = z.object({ models: z.array(z.object({
  slug: z.string().trim().min(1), display_name: z.string().trim().min(1),
  visibility: z.string(), priority: z.number().default(0),
  context_window: z.number().positive().nullable().optional(),
  input_modalities: z.array(z.string()).default([]),
  supported_reasoning_levels: z.array(z.object({ effort: z.string() })).default([]),
})).max(500) });

export function openAiSubscriptionModels(payload: unknown): ProviderModel[] {
  const advertised = CatalogSchema.parse(payload).models.filter(model => model.visibility === "list")
    .sort((a, b) => a.priority - b.priority);
  const ids = new Set<string>();
  return advertised.map(model => {
    if (ids.has(model.slug)) throw new Error("OpenAI returned a duplicate subscription model.");
    ids.add(model.slug);
    const reasoningEfforts = model.supported_reasoning_levels.map(level => level.effort)
      .filter((effort): effort is "off" | "low" | "medium" | "high" | "xhigh" | "max" =>
        ["off", "low", "medium", "high", "xhigh", "max"].includes(effort));
    return ProviderModelSchema.parse({ id: model.slug, providerId: "openai", displayName: model.display_name,
      source: "provider", contextWindow: model.context_window,
      capabilities: { streaming: true, toolCalling: true, reasoning: reasoningEfforts.length > 0,
        reasoningEfforts, vision: model.input_modalities.includes("image") } });
  });
}
