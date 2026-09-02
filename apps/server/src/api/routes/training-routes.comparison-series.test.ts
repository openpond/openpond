import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { handleTrainingRoutes } from "./training-routes.js";

class ResponseRecorder extends EventEmitter {
  statusCode = 0;
  payload = "";
  writableEnded = false;
  writeHead(status: number) { this.statusCode = status; return this; }
  setHeader() { return this; }
  end(value?: string) { this.payload = value ?? ""; this.writableEnded = true; return this; }
}

describe("Comparison Series training routes", () => {
  it.each([
    ["POST", "/v1/training/comparison-series/series-a/seal", "seal_model_comparison_series", "seriesId", "series-a"],
    ["POST", "/v1/training/comparison-series/series-a/releases", "queue_model_comparison_release", "seriesId", "series-a"],
    ["PATCH", "/v1/training/comparison-series-entries/entry-a/run", "link_model_comparison_run", "entryId", "entry-a"],
    ["POST", "/v1/training/comparison-series-entries/entry-a/retry", "retry_model_comparison_entry", "entryId", "entry-a"],
    ["POST", "/v1/training/comparison-series-entries/entry-a/decision", "decide_model_comparison_entry", "entryId", "entry-a"],
    ["POST", "/v1/training/comparison-series-entries/entry-a/promotion", "record_model_comparison_promotion", "entryId", "entry-a"],
  ])("routes %s %s through the authenticated training boundary", async (method, pathname, action, key, id) => {
    const request = Readable.from([JSON.stringify({ [key]: "forged-client-id", expectedRevision: 1 })]);
    Object.assign(request, { method, headers: { "content-type": "application/json" } });
    const response = new ResponseRecorder();
    const trainingPayload = vi.fn(async () => ({ ok: true }));
    const handled = await handleTrainingRoutes({
      deps: { trainingPayload } as never,
      request: request as never,
      requestUrl: new URL(`http://localhost${pathname}`),
      response: response as never,
    });
    expect(handled).toBe(true);
    expect(trainingPayload).toHaveBeenCalledWith(
      action,
      expect.objectContaining({ [key]: id }),
      expect.any(URL),
      expect.any(AbortSignal),
    );
    expect(response.statusCode).toBe(200);
  });
});
