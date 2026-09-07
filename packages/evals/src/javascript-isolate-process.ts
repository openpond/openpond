import { spawn } from "node:child_process";
import { javascriptIsolateProcessSource } from "./javascript-isolate-process-source.js";
import { validateJavaScriptIsolateInput, type JavaScriptIsolateInput } from "./javascript-isolate.js";
import { assertBoundedTaskJson } from "./task-schema.js";

/** A Node subprocess owns the interpreter; completion always waits for its exit. */
export async function executeJavaScriptIsolateInProcess(input: JavaScriptIsolateInput): Promise<unknown> {
  input.signal?.throwIfAborted();
  validateJavaScriptIsolateInput(input);
  const { signal, ...data } = input;
  const error = (suffix: string) => new Error(`${input.errorPrefix}_${suffix}`);
  // The authored source remains JSON data passed to QuickJS, never host code.
  const program = `globalThis.__openpondIsolateInput = JSON.parse(${JSON.stringify(JSON.stringify(data))});\n${javascriptIsolateProcessSource}`;
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["--max-old-space-size=64", "--input-type=commonjs", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH },
      windowsHide: true,
    });
    let failure: Error | undefined;
    let response = "";
    let responseBytes = 0;
    let stderrBytes = 0;
    const stop = (cause: Error) => {
      failure ??= cause;
      child.kill("SIGKILL");
    };
    const cancel = () => stop(signal?.reason instanceof Error ? signal.reason : error("cancelled"));
    const timer = setTimeout(() => stop(error("timeout")), input.timeoutMs);
    signal?.addEventListener("abort", cancel, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      responseBytes += Buffer.byteLength(chunk);
      if (responseBytes > input.maxResultBytes + 65_536) stop(error("process_response_too_large"));
      else response += chunk;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > 65_536) stop(error("process_stderr_too_large"));
    });
    child.once("error", (cause) => { failure ??= cause; });
    child.stdin.on("error", (cause) => stop(cause));
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (failure) { reject(failure); return; }
      try {
        if (code !== 0) throw error("process_exited_without_result");
        const message: unknown = JSON.parse(response);
        if (!message || typeof message !== "object" || !("ok" in message)) throw error("process_invalid_response");
        if (message.ok !== true) throw new Error("error" in message && typeof message.error === "string" ? message.error : `${input.errorPrefix}_execution_failed`);
        if (!("result" in message)) throw error("process_invalid_response");
        assertBoundedTaskJson(message.result, input.maxResultBytes);
        resolve(message.result);
      } catch (cause) { reject(cause instanceof Error ? cause : error("process_invalid_response")); }
    });
    child.stdin.end(program);
    if (signal?.aborted) cancel();
  });
}
