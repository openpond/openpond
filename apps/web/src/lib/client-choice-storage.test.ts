import { ConnectionRequestError } from "../api/connection-status";
import { afterEach, expect, test, vi } from "vitest";
import { clientChoiceStorage, connectClientChoices } from "./client-choice-storage";

afterEach(() => vi.unstubAllGlobals());

// StrictMode/startup callers share one read, but a changed server credential
// must start a new read and reject a late response from the previous owner.
test("coalesces concurrent hydration without reusing another connection's choices", async () => {
  const replies: Array<(response: Response) => void> = [];
  const fetch = vi.fn(() => new Promise<Response>(resolve => replies.push(resolve)));
  vi.stubGlobal("fetch", fetch);
  const firstConnection = { serverUrl: "http://local.invalid", token: "first", platform: "linux" };
  const first = connectClientChoices(firstConnection);
  expect(connectClientChoices({ ...firstConnection })).toBe(first);
  expect(fetch).toHaveBeenCalledTimes(1);

  const secondConnection = { ...firstConnection, token: "second" };
  const second = connectClientChoices(secondConnection);
  expect(fetch).toHaveBeenCalledTimes(2);
  replies[1]!(Response.json({ clientState: { owner: "second", revision: 1, value: { chatMode: "work" } } }));
  await second;
  replies[0]!(Response.json({ clientState: { owner: "first", revision: 1, value: { chatMode: "chat" } } }));
  await first;
  expect(clientChoiceStorage.getItem("openpond:last-chat-task-mode")).toBe("work");

  // Rehydration after completion must still observe account changes on the
  // same local connection; only in-flight requests are deduplicated.
  const refresh = connectClientChoices(secondConnection);
  expect(fetch).toHaveBeenCalledTimes(3);
  replies[2]!(Response.json({ clientState: { owner: "third", revision: 1, value: { chatMode: "chat" } } }));
  await refresh;
  expect(clientChoiceStorage.getItem("openpond:last-chat-task-mode")).toBe("chat");

  const previousAccount = connectClientChoices(secondConnection);
  const switchedAccount = connectClientChoices(secondConnection, { force: true });
  expect(fetch).toHaveBeenCalledTimes(5);
  replies[4]!(Response.json({ clientState: { owner: "switched", revision: 1, value: { chatMode: "work" } } }));
  await switchedAccount;
  replies[3]!(Response.json({ clientState: { owner: "third", revision: 1, value: { chatMode: "chat" } } }));
  await previousAccount;
  expect(clientChoiceStorage.getItem("openpond:last-chat-task-mode")).toBe("work");
});

test("a failed hydration can be retried", async () => {
  const fetch = vi.fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(Response.json({ clientState: { owner: "retry", revision: 1, value: { chatMode: "work" } } }));
  vi.stubGlobal("fetch", fetch);
  const connection = { serverUrl: "http://retry.invalid", token: "retry", platform: "linux" };
  await expect(connectClientChoices(connection)).rejects.toBeInstanceOf(ConnectionRequestError);
  await connectClientChoices(connection);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(clientChoiceStorage.getItem("openpond:last-chat-task-mode")).toBe("work");
});

// StrictMode/remount or a timeout may abandon hydration while a retry starts.
// A late response from that abandoned attempt must not replace the new owner.
test("aborted hydration does not block or overwrite its replacement", async () => {
  const replies: Array<(response: Response) => void> = [];
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => replies.push(resolve))));
  const connection = { serverUrl: "http://cancel.invalid", token: "cancel", platform: "linux" };
  const controller = new AbortController();
  const first = connectClientChoices(connection, { signal: controller.signal });
  const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  const second = connectClientChoices(connection);
  replies[1]!(Response.json({ clientState: { owner: "new", revision: 1, value: { chatMode: "work" } } }));
  await second;
  replies[0]!(Response.json({ clientState: { owner: "old", revision: 1, value: { chatMode: "chat" } } }));
  await rejected;
  expect(clientChoiceStorage.getItem("openpond:last-chat-task-mode")).toBe("work");
});
