import { describe, expect, test, vi } from "vitest";

import { resolveWebLaunchMessages } from "../apps/server/src/cli";

const baseUrl = "http://127.0.0.1:4317";
const token = "private-capability-token";

describe("server CLI web launch messages", () => {
  test("hands the authenticated URL to the browser without printing the token", async () => {
    const browser = vi.fn(async (url: string) => {
      expect(url).toContain("openpondServerUrl=");
      expect(url).toContain(`openpondToken=${token}`);
      return { opened: true as const };
    });

    const messages = await resolveWebLaunchMessages({
      baseUrl,
      openBrowser: true,
      printAccessUrl: false,
      token,
    }, browser);

    expect(browser).toHaveBeenCalledOnce();
    expect(messages).toEqual({
      stdout: [`Opened OpenPond in your browser: ${baseUrl}`],
      stderr: [],
    });
    expect(JSON.stringify(messages)).not.toContain(token);
  });

  test("prints an actionable authenticated URL when browser handoff fails", async () => {
    const messages = await resolveWebLaunchMessages({
      baseUrl,
      openBrowser: true,
      printAccessUrl: false,
      token,
    }, async () => ({ opened: false, error: "browser launcher unavailable" }));

    expect(messages.stderr).toEqual([
      "Could not open the system browser: browser launcher unavailable",
    ]);
    expect(messages.stdout[0]).toContain(baseUrl);
    expect(messages.stdout[0]).toContain(`openpondToken=${token}`);
  });

  test("prints the authenticated URL only when no-open is requested", async () => {
    const browser = vi.fn();
    const messages = await resolveWebLaunchMessages({
      baseUrl,
      openBrowser: false,
      printAccessUrl: true,
      token,
    }, browser);

    expect(browser).not.toHaveBeenCalled();
    expect(messages.stderr).toEqual([]);
    expect(messages.stdout[0]).toContain(`openpondToken=${token}`);
  });
});
