import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { buildProject } from "../scripts/build/project.ts";
import { ensureDevBuild } from "../scripts/build/dev-sdk";
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
      devAppHomePath({ OPENPOND_HOME: "/custom/openpond" }, "/test-home"),
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
      "watch",
      "apps/server/src/index.ts",
      "--port",
      "17874",
    ]);
    expect(plan.processes.find((processPlan) => processPlan.id === "desktop")?.env).toMatchObject({
      OPENPOND_HOME: plan.appHome,
      OPENPOND_SERVER_PORT: "17874",
      OPENPOND_WEB_PORT: "17876",
      OPENPOND_WEB_URL: "http://127.0.0.1:17876",
      OPENPOND_DESKTOP_DEV_MODE: "1",
      OPENPOND_DESKTOP_DEV_SUPERVISED: "1",
    });
  });

  // Failure story: attaching UI tests must not unexpectedly compile the repository
  // or enable a debugging listener in an ordinary development launch.
  test("keeps debugger opt-in and permits restart with existing build artifacts", () => {
    const ordinary = buildDevRunnerPlan(parseDevRunnerArgs(["desktop"], {}), {}, root);
    expect(ordinary.processes.find(process => process.id === "desktop")?.args).toEqual(["."]);
    const attached = buildDevRunnerPlan(parseDevRunnerArgs(["desktop", "--skip-build", "--devtools-port", "9333"], {}), {}, root);
    expect(attached.setupCommands).toEqual([]);
    expect(attached.processes.find(process => process.id === "desktop")?.args).toEqual([
      ".", "--remote-debugging-port=9333", "--remote-debugging-address=127.0.0.1",
    ]);
    expect(() => parseDevRunnerArgs(["web", "--devtools-port", "9333"], {})).toThrow("requires desktop mode");
    expect(() => parseDevRunnerArgs(["desktop", "--devtools-port", "70000"], {})).toThrow();
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
      "watch",
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
      "--home",
      path.join(root, ".openpond", "stable-web", "data"),
    ]);
    expect(
      plan.processes.find((processPlan) => processPlan.id === "desktop")?.env,
    ).toMatchObject({
      OPENPOND_HOME: path.join(root, ".openpond", "stable-web", "data"),
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
    expect(
      plan.processes.find((processPlan) => processPlan.id === "desktop")?.env,
    ).not.toHaveProperty("OPENPOND_DESKTOP_DEV_MODE");
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

  test("allows backend watching to be explicitly disabled", () => {
    const options = parseDevRunnerArgs(["server", "--no-watch"]);
    expect(options.watch).toBe(false);
    expect(buildDevRunnerPlan(options, {}, root).processes[0]?.args[0]).toBe("apps/server/src/index.ts");
  });

// Protects against silently launching stale or incomplete package artifacts.
test("dev build cache invalidates changed inputs, damaged outputs, and failed builds", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openpond-dev-build-"));
  const input = path.join(directory, "source.ts");
  const output = path.join(directory, "dist", "index.js");
  let builds = 0;
  let fail = false;
  const options = {
    inputs: [input], outputs: [path.dirname(output)], cacheFile: path.join(directory, "receipt.json"),
    async build() {
      builds += 1;
      if (fail) throw new Error("build failed");
      await fs.mkdir(path.dirname(output), { recursive: true });
      await fs.writeFile(output, await fs.readFile(input));
    },
  };
  try {
    await fs.writeFile(input, "first");
    expect(await ensureDevBuild(options)).toBe("built");
    expect(await ensureDevBuild(options)).toBe("cached");
    expect(builds).toBe(1);
    await fs.writeFile(input, "second");
    expect(await ensureDevBuild(options)).toBe("built");
    expect(await fs.readFile(output, "utf8")).toBe("second");
    await fs.rm(output);
    expect(await ensureDevBuild(options)).toBe("built");
    await fs.writeFile(input, "third");
    fail = true;
    await expect(ensureDevBuild(options)).rejects.toThrow("build failed");
    fail = false;
    expect(await ensureDevBuild(options)).toBe("built");
    expect(await ensureDevBuild(options)).toBe("cached");
    expect(await fs.readFile(output, "utf8")).toBe("third");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// Reusing a live server must not rebuild its files; a failed fresh setup must
// never fall through to launching old artifacts.
test("server reuse skips setup while fresh setup failures prevent launch", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openpond-dev-reuse-"));
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, server: "openpond-app-server" }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing listener");
  const options = parseDevRunnerArgs(["desktop", `--server-port=${address.port}`]);
  const plan = buildDevRunnerPlan(options, { OPENPOND_HOME: directory }, root);
  const marker = path.join(directory, "desktop-built");
  const launched = path.join(directory, "server-launched");
  const command = (id: string, source: string) => ({ id, command: process.execPath, args: ["-e", source], cwd: root, env: {} });
  plan.setupCommands = [
    command("build-dev-server", 'throw new Error("setup must not run for reuse")'),
    command("build-desktop", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "built")`),
  ];
  plan.processes = [
    command("server", `require("node:fs").writeFileSync(${JSON.stringify(launched)}, "launched")`),
    command("desktop", 'if (process.env.OPENPOND_REUSE_SERVER !== "1") process.exit(2)'),
  ];
  async function run() {
    return await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", `import { runDevPlan } from ${JSON.stringify(path.join(root, "scripts/dev-runner.ts"))}; await runDevPlan(${JSON.stringify(plan)});`], { cwd: root });
      let stderr = "";
      child.stdout.resume();
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", code => resolve({ code, stderr }));
    });
  }
  try {
    await fs.mkdir(path.join(directory, "secrets"));
    await fs.writeFile(path.join(directory, "secrets/server-token"), "test-token");
    expect((await run()).code).toBe(0);
    expect(await fs.readFile(marker, "utf8")).toBe("built");
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const failed = await run();
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain("setup must not run for reuse");
    await expect(fs.stat(launched)).rejects.toThrow();
  } finally {
    server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// A stale/deleted emit or failed build must never leave consumers with partial
// artifacts. Exercise the real compiler and publication boundary together.
test("incremental builds reuse emits, recover damage, remove stale files, and preserve the last good build", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openpond-compiler-"));
  try {
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          composite: true,
          declaration: true,
          declarationMap: true,
          sourceMap: true,
          strict: true,
          types: [],
          target: "ES2022",
          module: "ESNext",
          rootDir: "src",
          outDir: "dist",
        },
        include: ["src/**/*.ts"],
      }),
    );
    const source = path.join(root, "src/index.ts");
    const output = path.join(root, "dist/index.js");
    const cached = path.join(root, "node_modules/.cache/compiler/emit/index.js");
    await fs.writeFile(source, 'export const value: string = "first";');
    await fs.writeFile(path.join(root, "src/removed.ts"), "export const removed = 1;");
    await buildProject(root);
    const first = await fs.readFile(output, "utf8");
    const timestamp = (await fs.stat(cached)).mtimeMs;
    await Promise.all([buildProject(root), buildProject(root)]);
    expect((await fs.stat(cached)).mtimeMs).toBe(timestamp);
    await fs.rm(output);
    await fs.writeFile(cached, "corrupt");
    await buildProject(root);
    expect(await fs.readFile(output, "utf8")).toBe(first);
    await fs.rm(path.join(root, "src/removed.ts"));
    await fs.writeFile(source, 'export const value: string = "second";');
    await buildProject(root);
    expect(await fs.readFile(output, "utf8")).toContain("second");
    await expect(fs.stat(path.join(root, "dist/removed.js"))).rejects.toThrow();
    const map = JSON.parse(await fs.readFile(`${output}.map`, "utf8"));
    expect(path.resolve(path.dirname(output), map.sources[0])).toBe(source);
    await fs.writeFile(source, "export const value: string = 123;");
    await expect(buildProject(root)).rejects.toThrow("TypeScript exited");
    expect(await fs.readFile(output, "utf8")).toContain("second");
    await fs.writeFile(source, 'export const value: string = "recovered";');
    await buildProject(root);
    expect(await fs.readFile(output, "utf8")).toContain("recovered");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}, 180_000);
