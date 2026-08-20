import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  buildDevRunnerPlan,
  isReusableOpenPondHealth,
  parseDevRunnerArgs,
  vercelProtectionBypassSecret,
  type DevRunnerPlan,
} from "../scripts/dev-runner";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("dev runner", () => {
  test("only reuses a healthy OpenPond app server", () => {
    expect(isReusableOpenPondHealth({ ok: true, server: "openpond-app-server" })).toBe(true);
    expect(isReusableOpenPondHealth({ ok: false, server: "openpond-app-server" })).toBe(false);
    expect(isReusableOpenPondHealth({ ok: true, server: "another-service" })).toBe(false);
  });

  test("plans desktop dev with a watched server plus renderer and desktop processes", () => {
    const options = parseDevRunnerArgs(["desktop"], {
      OPENPOND_APP_CHANNEL: "stable",
    });
    const plan = buildDevRunnerPlan(options, {}, root);

    expect(plan.mode).toBe("desktop");
    expect(plan.ports).toEqual({ server: 17874, web: 17876 });
    expect(plan.urls).toEqual({
      server: "http://127.0.0.1:17874",
      web: "http://127.0.0.1:17876",
    });
    expect(plan.setupCommands.map((command) => command.id)).toEqual(["build-desktop"]);
    expect(plan.processes.map((processPlan) => processPlan.id)).toEqual([
      "server",
      "renderer",
      "desktop",
    ]);
    expect(plan.processes.find((processPlan) => processPlan.id === "server")?.args).toEqual([
      "apps/server/src/index.ts",
      "--port",
      "17874",
    ]);
    expect(plan.processes.find((processPlan) => processPlan.id === "desktop")?.env).toMatchObject({
      OPENPOND_SERVER_PORT: "17874",
      OPENPOND_WEB_PORT: "17876",
      OPENPOND_WEB_URL: "http://127.0.0.1:17876",
    });
  });

  test("injects an explicit Vercel bypass only into the local server", () => {
    const options = parseDevRunnerArgs(["desktop"]);
    const plan = buildDevRunnerPlan(
      options,
      { VERCEL_AUTOMATION_BYPASS_SECRET: "local-bypass" },
      root
    );

    expect(
      plan.processes.find((processPlan) => processPlan.id === "server")?.env
        .VERCEL_AUTOMATION_BYPASS_SECRET
    ).toBe("local-bypass");
    expect(
      plan.processes.find((processPlan) => processPlan.id === "renderer")?.env
        .VERCEL_AUTOMATION_BYPASS_SECRET
    ).toBeUndefined();
    expect(
      plan.processes.find((processPlan) => processPlan.id === "desktop")?.env
        .VERCEL_AUTOMATION_BYPASS_SECRET
    ).toBeUndefined();
  });

  test("selects the Vercel environment bypass without exposing metadata", () => {
    expect(
      vercelProtectionBypassSecret(
        JSON.stringify({
          protectionBypass: {
            fallback: { isEnvVar: false },
            preferred: { isEnvVar: true },
          },
        })
      )
    ).toBe("preferred");
    expect(vercelProtectionBypassSecret("not-json")).toBeNull();
  });

  test("plans web dev with only server and renderer processes using explicit ports", () => {
    const options = parseDevRunnerArgs([
      "web",
      "--server-port",
      "19074",
      "--web-port=19076",
    ]);
    const plan = buildDevRunnerPlan(options, {}, root);

    expect(plan.ports).toEqual({ server: 19074, web: 19076 });
    expect(plan.setupCommands).toEqual([]);
    expect(plan.processes.map((processPlan) => processPlan.id)).toEqual(["server", "renderer"]);
    expect(plan.processes.find((processPlan) => processPlan.id === "server")?.args).toEqual([
      "apps/server/src/index.ts",
      "--port",
      "19074",
    ]);
    expect(plan.processes.find((processPlan) => processPlan.id === "renderer")?.env).toMatchObject({
      OPENPOND_WEB_PORT: "19076",
      VITE_OPENPOND_SERVER_URL: "http://127.0.0.1:19074",
    });
  });

  test("prints the real runner plan without starting long-lived processes", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/dev-runner.ts",
        "server",
        "--server-port=19174",
        "--web-port=19176",
        "--print-plan",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          OPENPOND_APP_CHANNEL: "stable",
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const plan = JSON.parse(result.stdout) as DevRunnerPlan;
    expect(plan.mode).toBe("server");
    expect(plan.ports).toEqual({ server: 19174, web: 19176 });
    expect(plan.setupCommands).toEqual([]);
    expect(plan.processes.map((processPlan) => processPlan.id)).toEqual(["server"]);
  });
});

  test("plans desktop dev with a watched server when --watch is passed", () => {
    const options = parseDevRunnerArgs(["desktop", "--watch"], {
      OPENPOND_APP_CHANNEL: "stable",
    });
    const plan = buildDevRunnerPlan(options, {}, root);

    expect(plan.mode).toBe("desktop");
    expect(options.watch).toBe(true);
    expect(plan.processes.find((processPlan) => processPlan.id === "server")?.args).toEqual([
      "watch",
      "apps/server/src/index.ts",
      "--port",
      "17874",
    ]);
  });

  test("defaults to stable server when --watch is not passed", () => {
    const options = parseDevRunnerArgs(["server"]);
    expect(options.watch).toBe(false);
  });
