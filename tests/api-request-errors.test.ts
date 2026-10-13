import { expect, test, vi } from "vitest";
import { apiFetch, ApiRequestError } from "../apps/web/src/api/api-client";

// Structured server failures must retain a readable reason and HTTP status;
// coercing their envelope makes every UI action fail as [object Object].
test("reads structured API failures without discarding their message", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(
    { error: { code: "PREVIEW_DISCONNECTED", message: "The preview renderer is reconnecting." } }, { status: 503 },
  ));
  try {
    const error = await apiFetch({serverUrl:"http://localhost",token:"test",platform:"web"},"/test").catch(error=>error);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({status:503,message:"The preview renderer is reconnecting."});
  } finally {fetch.mockRestore();}
});
