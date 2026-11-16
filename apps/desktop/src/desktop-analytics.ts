import { randomUUID } from "node:crypto";
import { getLocalRecord, putLocalRecord } from "@openpond/persistence";
import { PostHog } from "posthog-node";
import { z } from "zod";
import type { DesktopAnalyticsConfig } from "./desktop-analytics-config.js";

const AccountSchema = z
  .object({
    state: z.enum(["signed_in", "signed_out", "loading", "switching", "auth_error"]),
    userId: z.string().min(1).max(200).nullable(),
    baseUrl: z.string().nullable(),
  })
  .strict();
const InstallationSchema = z
  .object({
    installationId: z.uuid(),
    firstOpenedAt: z.iso.datetime(),
    firstOpenEventId: z.uuid(),
    firstOpenDelivered: z.boolean(),
  })
  .strict();
type Installation = z.infer<typeof InstallationSchema>;

export type DesktopAnalyticsOptions = {
  home: string;
  config: DesktopAnalyticsConfig;
  version: string;
  channel: string;
  packaged: boolean;
  onFailure: () => void;
};

/** One owner per Electron process. Renderer reloads never create another app session. */
export class DesktopAnalytics {
  private readonly client: PostHog;
  private readonly installation: Installation;
  private readonly sessionId = randomUUID();
  private readonly authenticatedUsers = new Set<string>();
  private readonly pending = new Set<Promise<void>>();
  private started = false;
  private closed = false;
  private deliveryFailures = 0;

  constructor(private readonly options: DesktopAnalyticsOptions) {
    const saved = getLocalRecord(options.home, "client_preferences", "desktop_analytics");
    this.installation = saved
      ? InstallationSchema.parse(saved.value)
      : {
          installationId: randomUUID(),
          firstOpenedAt: new Date().toISOString(),
          firstOpenEventId: randomUUID(),
          firstOpenDelivered: false,
        };
    if (!saved)
      putLocalRecord(
        options.home,
        "client_preferences",
        "desktop_analytics",
        this.installation,
        null,
      );
    this.client = new PostHog(options.config.token, {
      host: options.config.host,
      requestTimeout: 2_000,
      fetchRetryCount: 0,
      disableGeoip: true,
      flushAt: 20,
      flushInterval: 0,
      enableExceptionAutocapture: false,
    });
    // Provider errors can contain request credentials; only report a fixed local diagnostic.
    this.client.on("error", () => {
      this.deliveryFailures++;
      options.onFailure();
    });
  }

  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    if (!this.installation.firstOpenDelivered) {
      this.send(
        "desktop_first_opened",
        null,
        {
          $insert_id: this.installation.firstOpenEventId,
        },
        new Date(this.installation.firstOpenedAt),
        () => {
          this.installation.firstOpenDelivered = true;
          putLocalRecord(
            this.options.home,
            "client_preferences",
            "desktop_analytics",
            this.installation,
          );
        },
      );
    }
    this.send("desktop_opened", null);
  }

  account(raw: unknown, loginSucceeded = false): void {
    if (this.closed) return;
    const account = AccountSchema.parse(raw);
    if (account.state !== "signed_in" || !account.userId || !account.baseUrl) return;
    let origin: string;
    try {
      origin = new URL(account.baseUrl).origin;
    } catch {
      return;
    }
    // A custom or staging account must not be merged with production people.
    if (origin !== new URL(this.options.config.accountOrigin).origin) return;
    if (!this.authenticatedUsers.has(account.userId)) {
      this.authenticatedUsers.add(account.userId);
      this.send("desktop_authenticated", account.userId);
    }
    if (loginSucceeded) this.send("desktop_login_succeeded", account.userId);
  }

  private send(
    event: string,
    userId: string | null,
    extra: Record<string, unknown> = {},
    timestamp = new Date(),
    delivered?: () => void,
  ): void {
    const failuresBeforeSend = this.deliveryFailures;
    const eventId = typeof extra.$insert_id === "string" ? extra.$insert_id : randomUUID();
    const operation = this.client
      .captureImmediate({
        distinctId: userId ?? `desktop:${this.installation.installationId}`,
        event,
        timestamp,
        uuid: eventId,
        properties: {
          $insert_id: eventId,
          $process_person_profile: Boolean(userId),
          source: "desktop",
          analytics_environment: this.options.packaged ? "production" : "development",
          installation_id: this.installation.installationId,
          desktop_session_id: this.sessionId,
          app_version: this.options.version,
          release_channel: this.options.channel,
          platform: process.platform,
          architecture: process.arch,
          ...extra,
        },
        // The SDK reports transport errors through its error event and resolves the promise.
        // Conservatively retain first-open evidence if any concurrent delivery failed.
      })
      .then(() => {
        if (this.deliveryFailures === failuresBeforeSend) delivered?.();
      })
      .catch(() => this.options.onFailure());
    this.pending.add(operation);
    void operation.finally(() => this.pending.delete(operation));
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(this.pending);
    await this.client.shutdown(2_000).catch(() => this.options.onFailure());
  }
}
