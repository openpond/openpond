import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { signalNativeProcess } from "@openpond/agent-runtime/acp/process-tree";
import type { AntigravityLoginState } from "@openpond/contracts";
import type { antigravityLaunch } from "./antigravity-profile.js";

const CALLBACK = "https://antigravity.google/oauth-callback";
const pendingPhases = new Set(["starting", "waiting_for_code", "verifying"]);
type Authorization = { url: string; state: string };

function authorization(value: string): Authorization | null {
  if (value.length > 16_384 || /\s/.test(value)) return null;
  const url = URL.parse(value);
  if (
    !url ||
    url.origin !== "https://accounts.google.com" ||
    !["/o/oauth2/auth", "/o/oauth2/v2/auth"].includes(url.pathname) ||
    url.username ||
    url.password ||
    url.hash ||
    url.searchParams.getAll("state").length !== 1 ||
    !url.searchParams.get("state") ||
    url.searchParams.get("state")!.length > 512 ||
    url.searchParams.getAll("redirect_uri").length !== 1 ||
    url.searchParams.get("redirect_uri") !== CALLBACK ||
    url.searchParams.getAll("response_type").length !== 1 ||
    url.searchParams.get("response_type") !== "code"
  )
    return null;
  return { url: value, state: url.searchParams.get("state")! };
}

function loginResponse(input: string, pending: Authorization): string {
  const value = input.trim();
  if (value.length > 16_384 || /[\r\n\0]/.test(value))
    throw new Error("Paste the code from Google's Antigravity page, or that page's full address.");
  if (/^[\w./~-]{1,2048}$/.test(value)) return value;
  const url = URL.parse(value);
  if (
    !url ||
    `${url.origin}${url.pathname}` !== CALLBACK ||
    url.username ||
    url.password ||
    url.hash ||
    url.searchParams.getAll("state").length !== 1 ||
    url.searchParams.get("state") !== pending.state ||
    url.searchParams.getAll("code").length !== 1 ||
    !url.searchParams.get("code")
  )
    throw new Error("This sign-in address does not belong to the current Google sign-in attempt.");
  return value;
}

export function createAntigravityLogin() {
  let state: AntigravityLoginState | null = null;
  let pending: Authorization | null = null;
  let child: ChildProcessWithoutNullStreams | null = null;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let completion: Promise<void> = Promise.resolve();
  let controller: AbortController | null = null;
  let closed = false;

  async function stop() {
    controller?.abort();
    if (deadline) clearTimeout(deadline);
    const process = child;
    if (!process || process.exitCode !== null || process.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => signalNativeProcess(process, "SIGKILL"), 2_000);
      kill.unref();
      process.once("close", () => {
        clearTimeout(kill);
        resolve();
      });
      signalNativeProcess(process, "SIGTERM");
    });
  }

  function fail(message: string) {
    if (!state || !pendingPhases.has(state.phase)) return;
    state = { ...state, phase: "failed", authorizationUrl: null, error: message };
    pending = null;
    void stop();
  }

  return {
    get active() {
      return Boolean(state && pendingPhases.has(state.phase));
    },
    snapshot(id?: string): AntigravityLoginState | null {
      return id && state?.id === id ? { ...state } : null;
    },
    async start(
      launch: ReturnType<typeof antigravityLaunch>,
      verify: (signal: AbortSignal) => Promise<void>,
    ): Promise<AntigravityLoginState> {
      if (closed) throw new Error("Antigravity setup is shutting down.");
      if (state && pendingPhases.has(state.phase))
        throw new Error(
          "Google sign-in is already in progress. Finish or cancel the current attempt.",
        );
      await stop();
      await completion;
      if (closed) throw new Error("Antigravity setup is shutting down.");
      controller = new AbortController();
      const signal = controller.signal;
      state = {
        id: randomUUID(),
        phase: "starting",
        authorizationUrl: null,
        expiresAt: new Date(Date.now() + 8 * 60_000).toISOString(),
        error: null,
      };
      pending = null;
      const process = spawn(launch.command, [...launch.args, "--login"], {
        cwd: launch.sourceHome,
        env: launch.env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        detached: globalThis.process.platform !== "win32",
      });
      child = process;
      const decoder = new StringDecoder("utf8");
      let buffer = "";
      let receivedBytes = 0;
      process.stdout.on("data", (chunk: Buffer) => {
        receivedBytes += chunk.length;
        if (receivedBytes > 256 * 1024) {
          fail("Antigravity returned too much sign-in output. Start sign-in again.");
          return;
        }
        buffer += decoder.write(chunk);
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line.startsWith("https://accounts.google.com/")) continue;
          const link = authorization(line);
          if (!link) {
            fail("Antigravity returned an invalid Google sign-in link.");
            return;
          }
          if (state?.phase === "starting") {
            pending = link;
            state = { ...state, phase: "waiting_for_code", authorizationUrl: link.url };
          }
        }
      });
      // Native output may contain credentials. Only the validated authorization link reaches the client.
      process.stderr.resume();
      process.stdin.on("error", () =>
        fail("Could not deliver the code to Antigravity. Start sign-in again."),
      );
      process.once("error", () =>
        fail("Could not start Antigravity sign-in. Check the runtime installation."),
      );
      completion = new Promise<void>((resolve) =>
        process.once("close", (code) => {
          void (async () => {
            if (!state || !pendingPhases.has(state.phase) || signal.aborted) return;
            if (code !== 0) {
              fail("Antigravity could not finish Google sign-in. Start sign-in again.");
              return;
            }
            state = { ...state, phase: "verifying", authorizationUrl: null };
            pending = null;
            try {
              await verify(signal);
              signal.throwIfAborted();
              state = { ...state!, phase: "complete", authorizationUrl: null, error: null };
            } catch {
              fail(
                "Google sign-in finished, but Antigravity could not verify account access or load models. Refresh the connection to check the provider's response.",
              );
            }
          })().finally(() => {
            if (deadline) clearTimeout(deadline);
            resolve();
          });
        }),
      );
      deadline = setTimeout(() => fail("Google sign-in expired. Start sign-in again."), 8 * 60_000);
      deadline.unref();
      return { ...state };
    },
    submit(id: string, response: string) {
      if (
        state?.id !== id ||
        state.phase !== "waiting_for_code" ||
        !pending ||
        !child ||
        Date.now() >= Date.parse(state.expiresAt)
      )
        throw new Error(
          "This sign-in attempt is no longer waiting for a code. Start sign-in again.",
        );
      const value = loginResponse(response, pending);
      state = { ...state, phase: "verifying", authorizationUrl: null };
      child.stdin.end(`${value}\n`);
    },
    async cancel(id?: string) {
      if (id && state?.id !== id) throw new Error("This sign-in attempt is no longer active.");
      if (state && pendingPhases.has(state.phase))
        state = { ...state, phase: "cancelled", authorizationUrl: null, error: null };
      pending = null;
      await stop();
      await completion;
    },
    async close() {
      closed = true;
      await this.cancel();
    },
  };
}
