import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { EmbeddedConfig } from "../config.js";
import { extractEngine, readEmbeddedManifest, verifySection } from "./package.js";

export type EmbeddedModel = { endpoint: string; ready(): boolean; close(): Promise<void> };

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (!address || typeof address === "string") throw new Error("Cannot reserve loopback port");
  return address.port;
}

/** One model owner per process, reused across isolated app-server chat requests. */
export async function startEmbeddedModel(config: EmbeddedConfig): Promise<EmbeddedModel> {
  const executable = process.execPath;
  const manifest = await readEmbeddedManifest(executable);
  const directory = await mkdtemp(path.join(os.tmpdir(), "openpond-inference-"));
  let child: ChildProcess | undefined;
  let exited: Promise<void> = Promise.resolve();
  let closing: Promise<void> | undefined;
  let healthy = false;
  const close = () => closing ??= (async () => {
    healthy = false;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const timeout = setTimeout(() => child?.kill("SIGKILL"), 5000).unref();
      try { await exited; } finally { clearTimeout(timeout); }
    }
    await rm(directory, { recursive: true, force: true });
  })();
  try {
    const engine = path.join(directory, "llama-server");
    await extractEngine(executable, manifest, engine);
    await verifySection(executable, manifest.model);
    const port = await reservePort();
    const endpoint = `http://127.0.0.1:${port}/v1`;
    child = spawn(engine, [
      "--model", executable, "--host", "127.0.0.1", "--port", String(port), "--alias", config.model,
      "--ctx-size", String(config.contextTokens), "--parallel", "1", "--threads", "2", "--threads-http", "2",
      "--batch-size", "64", "--ubatch-size", "64", "--cache-type-k", "q8_0", "--cache-type-v", "q8_0",
      "--n-gpu-layers", "0", "--no-repack", "--cache-ram", "0", "--flash-attn", "on", "--fit", "off",
      "--reasoning", "off", "--chat-template-kwargs", '{"enable_thinking":false}', "--no-context-shift",
    ], { cwd: directory, env: { HOME: directory, TMPDIR: directory, OPENPOND_EMBEDDED_GGUF_OFFSET: String(manifest.model.offset) },
      stdio: ["ignore", "ignore", "pipe"] });
    // Drain diagnostics without retaining prompts or exposing native errors to callers.
    child.stderr?.on("data", bytes => {
      if (!healthy && process.env.TVC_LOCAL_MODEL_DIAGNOSTICS === "1") process.stderr.write(bytes);
    });
    let failure: Error | undefined;
    exited = new Promise(resolve => {
      child!.once("error", error => { failure = error; healthy = false; resolve(); });
      child!.once("exit", () => { healthy = false; resolve(); });
    });
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (failure || child.exitCode !== null || child.signalCode !== null) throw new Error("Embedded model process failed during startup");
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000), redirect: "error" });
        if (response.ok) { healthy = true; return { endpoint, ready: () => healthy && !closing, close }; }
      } catch { /* Model loading is bounded by the startup deadline. */ }
      await delay(100);
    }
    throw new Error("Embedded model startup timed out");
  } catch (error) { await close(); throw error; }
}
