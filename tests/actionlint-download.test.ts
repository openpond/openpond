import { createHash } from "node:crypto";
import { expect, test, vi } from "vitest";
import { downloadVerifiedActionlintArchive } from "../scripts/actionlint-download";

// A transient release-host outage must not fail CI immediately, but retries
// must never install changed bytes or turn a permanent rejection into a loop.
test("the pinned linter transfer retries transient failures and fails closed on changed bytes", async () => {
  const archive = "verified fixture bytes", expected = createHash("sha256").update(archive).digest("hex");
  const request = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError("Connection reset"))
    .mockResolvedValueOnce(new Response("Unavailable", { status: 504 })).mockResolvedValueOnce(new Response(archive));
  const pause = vi.fn(async () => {});
  expect((await downloadVerifiedActionlintArchive("https://example.test/pinned-release", expected, { fetch: request, pause })).toString()).toBe(archive);
  expect(request).toHaveBeenCalledTimes(3);
  expect(pause.mock.calls).toEqual([[1000], [2000]]);

  const changed = vi.fn<typeof fetch>().mockResolvedValue(new Response("changed bytes"));
  await expect(downloadVerifiedActionlintArchive("https://example.test/pinned-release", expected, { fetch: changed, pause })).rejects.toThrow("checksum mismatch");
  expect(changed).toHaveBeenCalledTimes(1);
  const denied = vi.fn<typeof fetch>().mockResolvedValue(new Response("Not found", { status: 404 }));
  await expect(downloadVerifiedActionlintArchive("https://example.test/pinned-release", expected, { fetch: denied, pause })).rejects.toThrow("HTTP 404");
  expect(denied).toHaveBeenCalledTimes(1);

  const outage = vi.fn<typeof fetch>().mockImplementation(async () => new Response("Unavailable", { status: 504 }));
  await expect(downloadVerifiedActionlintArchive("https://example.test/pinned-release", expected, { fetch: outage, pause })).rejects.toThrow("four attempts");
  expect(outage).toHaveBeenCalledTimes(4);
});
