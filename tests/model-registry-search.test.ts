import { describe, expect, it, vi } from "vitest";

import { searchHuggingFaceModels } from "../apps/server/src/training/model-registry-search.js";

describe("training Model registry search", () => {
  it("projects exact Hugging Face revisions without downloading weights", async () => {
    const request = vi.fn(async () =>
      new Response(JSON.stringify([
        {
          id: "org/model-7b",
          sha: "0123456789abcdef",
        },
      ]), { status: 200 }),
    );

    const results = await searchHuggingFaceModels("model", request);

    expect(results).toEqual([
      {
        modelId: "org/model-7b",
        revision: "0123456789abcdef",
        label: "Model 7B",
      },
    ]);
    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0]!;
    expect(String(url)).toContain("search=model");
    expect(init?.method).toBeUndefined();
  });

  it("does not contact the registry for an incomplete query", async () => {
    const request = vi.fn<typeof fetch>();

    await expect(searchHuggingFaceModels("x", request)).resolves.toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });
});
