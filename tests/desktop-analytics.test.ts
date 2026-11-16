import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopAnalytics } from "../apps/desktop/src/desktop-analytics.js";
import { desktopAnalyticsConfig } from "../apps/desktop/src/desktop-analytics-config.js";

const resources: { server: Server; home: string }[] = [];
afterEach(async () => {
  for (const { server, home } of resources.splice(0)) {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(home, { recursive: true, force: true });
  }
});

type Captured = {
  event: string;
  distinct_id: string;
  uuid: string;
  properties: Record<string, unknown>;
  timestamp: string;
};
async function receiver() {
  const events: Captured[] = [];
  let fail = false;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks);
    const body = JSON.parse(
      (request.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw).toString(),
    );
    events.push(...(body.batch ?? [body]));
    response.writeHead(fail ? 503 : 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ status: fail ? 0 : 1 }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const home = await mkdtemp(path.join(os.tmpdir(), "openpond-analytics-"));
  resources.push({ server, home });
  let failures = 0;
  return {
    events,
    fail: (value: boolean) => {
      fail = value;
    },
    failures: () => failures,
    open: () =>
      new DesktopAnalytics({
        home,
        config: {
          token: "phc_test",
          host: `http://127.0.0.1:${address.port}`,
          accountOrigin: "https://account.example",
        },
        version: "1.0.0",
        channel: "stable",
        packaged: false,
        onFailure: () => {
          failures++;
        },
      }),
  };
}

describe("desktop analytics delivery boundary", () => {
  it("counts launches and verified sign-ins independently without merging accounts or exporting account details", async () => {
    const capture = await receiver();
    const analytics = capture.open();
    analytics.start();
    analytics.start();
    const account = { state: "signed_in", userId: "user-a", baseUrl: "https://account.example" };
    analytics.account(account);
    analytics.account(account);
    analytics.account({ ...account, state: "auth_error" });
    analytics.account({ ...account, baseUrl: "https://staging.example" }, true);
    analytics.account(account, true);
    analytics.account({ state: "signed_out", userId: null, baseUrl: null });
    analytics.account({ ...account, userId: "user-b" }, true);
    analytics.account(account);
    expect(() => analytics.account({ ...account, apiKey: "never-export-me" }, true)).toThrow();
    await analytics.close();
    const counts = (event: string) => capture.events.filter((item) => item.event === event);
    expect(counts("desktop_first_opened")).toHaveLength(1);
    expect(counts("desktop_opened")).toHaveLength(1);
    expect(
      counts("desktop_authenticated")
        .map((item) => item.distinct_id)
        .sort(),
    ).toEqual(["user-a", "user-b"]);
    expect(counts("desktop_login_succeeded")).toHaveLength(2);
    expect(
      capture.events.every((item) => item.properties.analytics_environment === "development"),
    ).toBe(true);
    expect(JSON.stringify(capture.events)).not.toMatch(
      /never-export-me|account\.example|staging\.example|\$anon_distinct_id|\$create_alias/,
    );
    const reopened = capture.open();
    reopened.start();
    reopened.account(account);
    await reopened.close();
    expect(counts("desktop_first_opened")).toHaveLength(1);
    expect(counts("desktop_opened")).toHaveLength(2);
    expect(counts("desktop_authenticated")).toHaveLength(3);
    expect(counts("desktop_login_succeeded")).toHaveLength(2);
    expect(
      new Set(counts("desktop_opened").map((item) => item.properties.installation_id)).size,
    ).toBe(1);
    expect(
      new Set(counts("desktop_opened").map((item) => item.properties.desktop_session_id)).size,
    ).toBe(2);
  });

  it("retries an unconfirmed first launch with its original deduplication ID and timestamp", async () => {
    const capture = await receiver();
    capture.fail(true);
    const first = capture.open();
    first.start();
    await first.close();
    expect(capture.failures()).toBeGreaterThan(0);
    capture.fail(false);
    const retry = capture.open();
    retry.start();
    await retry.close();
    const delivered = capture.open();
    delivered.start();
    await delivered.close();
    const attempts = capture.events.filter((item) => item.event === "desktop_first_opened");
    expect(attempts).toHaveLength(2);
    expect(attempts[0].properties.$insert_id).toBe(attempts[1].properties.$insert_id);
    expect(attempts[0].uuid).toBe(attempts[1].uuid);
    expect(attempts[0].timestamp).toBe(attempts[1].timestamp);
    expect(desktopAnalyticsConfig({ OPENPOND_POSTHOG_TOKEN: "phc_test" }, false)).toBeNull();
    expect(
      desktopAnalyticsConfig(
        { OPENPOND_ANALYTICS_ENABLED: "0", OPENPOND_POSTHOG_TOKEN: "phc_test" },
        true,
      ),
    ).toBeNull();
    expect(
      desktopAnalyticsConfig({ OPENPOND_POSTHOG_TOKEN: "phx_personal_secret" }, true),
    ).toBeNull();
  });
});
