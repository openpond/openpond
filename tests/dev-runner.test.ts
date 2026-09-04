import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  buildDevRunnerPlan,
  devAppHomePath,
  devServerReadyTimeoutMs,
  isReusableOpenPondHealth,
  parseDevRunnerArgs,
  type DevRunnerPlan,
} from "../scripts/dev-runner";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("dev runner", () => {
  test("isolates persistent development state from installed app state", () => {
    expect(devAppHomePath({}, "/test-home")).toBe(
      "/test-home/.openpond/openpond-app-dev",
    );
    expect(
      devAppHomePath({ OPENPOND_APP_CHANNEL: "nightly" }, "/test-home"),
    ).toBe("/test-home/.openpond/openpond-app-nightly-dev");
    expect(
      devAppHomePath({ OPENPOND_APP_HOME: "/custom/openpond" }, "/test-home"),
    ).toBe("/custom/openpond");
  });

  test("allows state-heavy app servers enough time to become ready", () => {
    expect(devServerReadyTimeoutMs({})).toBe(60_000);
    expect(
      devServerReadyTimeoutMs({
        OPENPOND_DEV_SERVER_READY_TIMEOUT_MS: "90000",
      }),
    ).toBe(90_000);
    expect(
      devServerReadyTimeoutMs({
        OPENPOND_DEV_SERVER_READY_TIMEOUT_MS: "invalid",
      }),
    ).toBe(60_000);
  });

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
    expect(plan.appHome).toBe(devAppHomePath({ OPENPOND_APP_CHANNEL: "stable" }));
    expect(plan.setupCommands.map((command) => command.id)).toEqual([
      "build-dev-server",
      "build-desktop",
    ]);
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
      OPENPOND_APP_HOME: plan.appHome,
      OPENPOND_SERVER_PORT: "17874",
      OPENPOND_WEB_PORT: "17876",
      OPENPOND_WEB_URL: "http://127.0.0.1:17876",
    });
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
    expect(plan.setupCommands.map((command) => command.id)).toEqual([
      "build-dev-server",
    ]);
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

  test("plans a frozen desktop build isolated from the hot-reloading dev app", () => {
    const options = parseDevRunnerArgs(["stable-desktop"]);
    const plan = buildDevRunnerPlan(options, {}, root);

    expect(plan.mode).toBe("stable-desktop");
    expect(plan.ports).toEqual({ server: 17878, web: 17878 });
    expect(plan.urls).toEqual({
      server: "http://127.0.0.1:17878",
      web: "http://127.0.0.1:17878",
    });
    expect(plan.appHome).toBe(
      path.join(root, ".openpond", "stable-web", "data"),
    );
    expect(plan.setupCommands.map((command) => command.id)).toEqual([
      "build-stable-web",
      "build-desktop",
    ]);
    expect(plan.processes.map((processPlan) => processPlan.id)).toEqual([
      "server",
      "desktop",
    ]);
    expect(
      plan.processes.find((processPlan) => processPlan.id === "server")?.args,
    ).toEqual([
      path.join(root, "apps", "server", "dist", "index.js"),
      "web",
      "--hostname",
      "127.0.0.1",
      "--port",
      "17878",
      "--web-root",
      path.join(root, ".openpond", "stable-web", "build"),
      "--store-dir",
      path.join(root, ".openpond", "stable-web", "data"),
    ]);
    expect(
      plan.processes.find((processPlan) => processPlan.id === "desktop")?.env,
    ).toMatchObject({
      OPENPOND_APP_HOME: path.join(root, ".openpond", "stable-web", "data"),
      OPENPOND_DESKTOP_USER_DATA_DIR: path.join(
        root,
        ".openpond",
        "stable-desktop",
        "user-data",
      ),
      OPENPOND_SERVER_PORT: "17878",
      OPENPOND_WEB_PORT: "17878",
      OPENPOND_WEB_URL: "http://127.0.0.1:17878",
    });
  });

  test("requires one origin for Stable Desktop's built UI and API", () => {
    const options = parseDevRunnerArgs([
      "stable-desktop",
      "--server-port=19078",
      "--web-port=19079",
    ]);

    expect(() => buildDevRunnerPlan(options, {}, root)).toThrow(
      "--web-port must match --server-port",
    );
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
    expect(plan.setupCommands.map((command) => command.id)).toEqual([
      "build-dev-server",
    ]);
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
