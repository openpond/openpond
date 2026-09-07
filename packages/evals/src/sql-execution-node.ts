import { spawn } from "node:child_process";
import { sqlExecutionProcessSource } from "./sql-execution-process-source.js";
import { assertBoundedTaskJson } from "./task-schema.js";
import { assertSqlExecutionRequest, SqlExecutionResultSchema, type SqlExecutionRequest, type SqlExecutionResult } from "./sql-execution-contract.js";
export * from "./sql-execution-contract.js";

/** Every result, cancellation and timeout settles after the owned child exits. */
export async function executeSqlInProcess(input: { request: SqlExecutionRequest; timeoutMs: number; signal?: AbortSignal }): Promise<SqlExecutionResult> {
  input.signal?.throwIfAborted();
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 30_000) throw new Error("sql_timeout_invalid");
  const request = assertSqlExecutionRequest(input.request);
  const { signal } = input;
  const program = `globalThis.__openpondSqlInput = JSON.parse(${JSON.stringify(JSON.stringify(request))});\n${sqlExecutionProcessSource}`;
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["--max-old-space-size=64", "--input-type=module", "-"], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH }, windowsHide: true });
    let failure: Error | undefined, output = "", outputBytes = 0, stderrBytes = 0;
    const stop = (error: Error) => { failure ??= error; child.kill("SIGKILL"); };
    const cancel = () => stop(signal?.reason instanceof Error ? signal.reason : new Error("sql_cancelled"));
    const timer = setTimeout(() => stop(new Error("sql_timeout")), input.timeoutMs);
    signal?.addEventListener("abort", cancel, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > request.maxResultBytes + 65_536) stop(new Error("sql_process_response_too_large"));
      else output += chunk;
    });
    child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.byteLength; if (stderrBytes > 65_536) stop(new Error("sql_process_stderr_too_large")); });
    child.once("error", error => { failure ??= error; });
    child.stdin.on("error", error => stop(error));
    child.once("close", code => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (failure) { reject(failure); return; }
      try {
        if (code !== 0) throw new Error("sql_process_exited_without_result");
        const message: unknown = JSON.parse(output);
        if (!message || typeof message !== "object" || !("ok" in message) || message.ok !== true || !("result" in message)) throw new Error("sql_environment_failed");
        const result = SqlExecutionResultSchema.parse(message.result);
        assertBoundedTaskJson(result, request.maxResultBytes);
        resolve(result);
      } catch (error) { reject(error); }
    });
    child.stdin.end(program);
    if (signal?.aborted) cancel();
  });
}
