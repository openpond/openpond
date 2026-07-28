export type RegistryModelSearchResult = {
  modelId: string;
  revision: string | null;
  label: string;
};

type HuggingFaceModel = {
  id?: unknown;
  modelId?: unknown;
  sha?: unknown;
};

export async function searchHuggingFaceModels(
  query: string,
  request: typeof fetch = fetch,
): Promise<RegistryModelSearchResult[]> {
  const normalized = query.trim();
  if (normalized.length < 2) return [];
  const url = new URL("https://huggingface.co/api/models");
  url.searchParams.set("search", normalized);
  url.searchParams.set("pipeline_tag", "text-generation");
  url.searchParams.set("limit", "24");
  url.searchParams.set("full", "true");
  const response = await request(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(
      `Hugging Face Model search failed with HTTP ${response.status}.`,
    );
  }
  const payload = await response.json() as unknown;
  if (!Array.isArray(payload)) {
    throw new Error("Hugging Face Model search returned an invalid payload.");
  }
  const seen = new Set<string>();
  const results: RegistryModelSearchResult[] = [];
  for (const item of payload as HuggingFaceModel[]) {
    const modelId =
      typeof item.modelId === "string"
        ? item.modelId
        : typeof item.id === "string"
          ? item.id
          : null;
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    results.push({
      modelId,
      revision: typeof item.sha === "string" ? item.sha : null,
      label: modelLabel(modelId),
    });
  }
  return results;
}

function modelLabel(modelId: string): string {
  const value = modelId.split("/").at(-1) ?? modelId;
  return value
    .replace(/(\d+)p(\d+)b/gi, "$1.$2B")
    .replace(/(\d+)b/gi, "$1B")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (part) => part.toUpperCase());
}
