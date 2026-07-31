import { describe, expect, test, vi } from "vitest";

import {
  ensureStagingVercelProtectionBypass,
  vercelProtectionBypassSecret,
} from "../src/cli/common/vercel-protection";

describe("CLI staging Vercel protection bootstrap", () => {
  test("loads the env-var bypass from the linked staging project", () => {
    const env: NodeJS.ProcessEnv = {};
    const run = vi.fn(() => ({
      status: 0,
      stdout: JSON.stringify({
        protectionBypass: {
          fallback: { isEnvVar: false },
          "staging-bypass": { isEnvVar: true },
        },
      }),
    }));

    expect(
      ensureStagingVercelProtectionBypass(
        "https://api-new.staging-api.openpond.ai/v1/sandboxes",
        { cwd: "/workspace/openpond", env, run }
      )
    ).toBe(true);
    expect(env.VERCEL_AUTOMATION_BYPASS_SECRET).toBe("staging-bypass");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      args: ["project", "protection", "--format", "json"],
      cwd: "/workspace/sandbox",
    });
  });

  test("honors an explicit linked project directory", () => {
    const env: NodeJS.ProcessEnv = {
      OPENPOND_VERCEL_PROJECT_DIR: "/projects/openpond-staging",
    };
    const run = vi.fn(() => ({
      status: 0,
      stdout: JSON.stringify({
        protectionBypass: { "explicit-bypass": { isEnvVar: true } },
      }),
    }));

    expect(
      ensureStagingVercelProtectionBypass("https://staging.openpond.ai", {
        cwd: "/workspace/openpond",
        env,
        run,
      })
    ).toBe(true);
    expect(run.mock.calls[0]?.[0].cwd).toBe("/projects/openpond-staging");
    expect(env.VERCEL_AUTOMATION_BYPASS_SECRET).toBe("explicit-bypass");
  });

  test("does not invoke Vercel for production or an existing bypass", () => {
    const run = vi.fn(() => ({ status: 1, stdout: "" }));
    expect(
      ensureStagingVercelProtectionBypass("https://api.openpond.ai", {
        env: {},
        run,
      })
    ).toBe(false);
    expect(
      ensureStagingVercelProtectionBypass(
        "https://api-new.staging-api.openpond.ai",
        {
          env: { VERCEL_AUTOMATION_BYPASS_SECRET: "already-set" },
          run,
        }
      )
    ).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  test("fails closed without exposing or installing an invalid bypass", () => {
    const env: NodeJS.ProcessEnv = {};
    const run = vi.fn(() => ({ status: 0, stdout: "not-json" }));

    expect(
      ensureStagingVercelProtectionBypass(
        "https://api-new.staging-api.openpond.ai",
        { cwd: "/workspace/openpond", env, run }
      )
    ).toBe(false);
    expect(env.VERCEL_AUTOMATION_BYPASS_SECRET).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(2);
  });

  test("parses the preferred env-var bypass without logging it", () => {
    expect(
      vercelProtectionBypassSecret(
        JSON.stringify({
          protectionBypass: {
            first: { isEnvVar: false },
            preferred: { isEnvVar: true },
          },
        })
      )
    ).toBe("preferred");
    expect(vercelProtectionBypassSecret("not-json")).toBeNull();
  });
});
