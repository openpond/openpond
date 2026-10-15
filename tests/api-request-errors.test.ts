import { expect, test, vi } from "vitest";
import { apiFetch, ApiRequestError } from "../apps/web/src/api/api-client";
import { ConnectionRequestError, connectionStatus, reportConnectionRestored, subscribeConnectionStatus } from "../apps/web/src/api/connection-status";
import { isConnectionErrorMessage } from "../apps/web/src/lib/error-messages";

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

// Many pages can fail together during a restart. Notify once, ignore cancelled
// work and old failures, and keep a different account's connection independent.
test("owns concurrent transport failures until recovery without hiding server errors", async () => {
  const connection = { serverUrl: "http://restart-test", token: "one", platform: "web" };
  const other = { ...connection, token: "two" };
  const notify = vi.fn();
  const unsubscribe = subscribeConnectionStatus(connection, notify);
  let rejectOld!: (error: Error) => void;
  const fetch = vi.spyOn(globalThis, "fetch")
    .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }))
    .mockRejectedValue(new TypeError("Failed to fetch"));
  try {
    const oldRequest = apiFetch(connection, "/slow").catch(error => error);
    const errors = await Promise.all([apiFetch(connection, "/a"), apiFetch({ ...connection }, "/b")].map(p => p.catch(error => error)));
    expect(errors.every(error => error instanceof ConnectionRequestError)).toBe(true);
    expect(isConnectionErrorMessage(errors[0].message)).toBe(true);
    expect(connectionStatus(connection).error).toBeTruthy();
    expect(connectionStatus(other).error).toBeNull();
    expect(notify).toHaveBeenCalledTimes(1);

    reportConnectionRestored({ ...connection });
    rejectOld(new TypeError("Failed to fetch"));
    await oldRequest;
    expect(connectionStatus(connection).error).toBeNull();
    expect(notify).toHaveBeenCalledTimes(2);

    const controller = new AbortController();
    controller.abort();
    fetch.mockRejectedValueOnce(new DOMException("Cancelled", "AbortError"));
    await expect(apiFetch(connection, "/cancelled", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(connectionStatus(connection).error).toBeNull();

    fetch.mockResolvedValueOnce(Response.json({ error: "Sign in to your agent." }, { status: 401 }));
    const actionable = await apiFetch(connection, "/setup").catch(error => error);
    expect(actionable).toBeInstanceOf(ApiRequestError);
    expect(isConnectionErrorMessage(actionable.message)).toBe(false);
    expect(connectionStatus(connection).error).toBeNull();

    await apiFetch(connection, "/new-outage").catch(() => {});
    expect(notify).toHaveBeenCalledTimes(3);
    reportConnectionRestored(connection);
    fetch.mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) { controller.error(new TypeError("Connection closed while reading the response.")); },
    })));
    await expect(apiFetch(connection, "/interrupted-body")).rejects.toBeInstanceOf(ConnectionRequestError);
    expect(connectionStatus(connection).error).toBeTruthy();
    expect(notify).toHaveBeenCalledTimes(5);
  } finally { unsubscribe(); fetch.mockRestore(); }
});
