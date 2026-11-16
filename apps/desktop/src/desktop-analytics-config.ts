import { z } from "zod";

const ConfigSchema = z
  .object({
    token: z.string().regex(/^phc_[A-Za-z0-9_-]+$/),
    host: z.url().refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
      );
    }),
    accountOrigin: z.url(),
  })
  .strict();
export type DesktopAnalyticsConfig = z.infer<typeof ConfigSchema>;

// Replaced by the desktop bundler; the unbundled development entrypoint has no defaults.
declare const __OPENPOND_DESKTOP_ANALYTICS__: unknown;

export function desktopAnalyticsConfig(
  env: NodeJS.ProcessEnv,
  packaged: boolean,
): DesktopAnalyticsConfig | null {
  if (
    env.OPENPOND_ANALYTICS_ENABLED === "0" ||
    (!packaged && env.OPENPOND_ANALYTICS_ENABLED !== "1")
  )
    return null;
  const bundled =
    typeof __OPENPOND_DESKTOP_ANALYTICS__ === "undefined" ? null : __OPENPOND_DESKTOP_ANALYTICS__;
  const config = env.OPENPOND_POSTHOG_TOKEN
    ? {
        token: env.OPENPOND_POSTHOG_TOKEN,
        host: env.OPENPOND_POSTHOG_HOST || "https://us.i.posthog.com",
        accountOrigin: env.OPENPOND_ANALYTICS_ACCOUNT_ORIGIN || "https://openpond.ai",
      }
    : bundled;
  const parsed = ConfigSchema.safeParse(config);
  return parsed.success ? parsed.data : null;
}
