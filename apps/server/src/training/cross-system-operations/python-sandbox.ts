import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { tmpdir } from "node:os";
import readline from "node:readline";
import { randomUUID } from "node:crypto";

const WORKER_SOURCE = String.raw`
import contextlib, io, json, math, statistics, decimal, datetime, collections, itertools, functools, resource, sys

resource.setrlimit(resource.RLIMIT_CPU, (5, 5))
resource.setrlimit(resource.RLIMIT_AS, (268435456, 268435456))
ALLOWED_MODULES = {"math", "statistics", "decimal", "datetime", "collections", "itertools", "functools", "json"}
real_import = __import__
def safe_import(name, globals=None, locals=None, fromlist=(), level=0):
    root = name.split(".", 1)[0]
    if root not in ALLOWED_MODULES:
        raise ImportError("module is not available in the standard-library-only sandbox")
    return real_import(name, globals, locals, fromlist, level)

safe_builtins = {
    "abs": abs, "all": all, "any": any, "bool": bool, "dict": dict, "enumerate": enumerate,
    "filter": filter, "float": float, "int": int, "len": len, "list": list, "map": map,
    "max": max, "min": min, "next": next, "print": print, "range": range, "repr": repr,
    "reversed": reversed, "round": round, "set": set, "sorted": sorted, "str": str,
    "sum": sum, "tuple": tuple, "zip": zip, "Exception": Exception, "ValueError": ValueError,
    "TypeError": TypeError, "__import__": safe_import,
}
state = {"__builtins__": safe_builtins}
for line in sys.stdin:
    request_id = ""
    try:
        request = json.loads(line)
        request_id = str(request.get("id") or "")
        code = request.get("code")
        if not request_id or not isinstance(code, str) or not code.strip():
            raise ValueError("id and non-empty code are required")
        output = io.StringIO()
        state.pop("_result", None)
        with contextlib.redirect_stdout(output):
            exec(compile(code, "<openpond-run-python>", "exec"), state, state)
        rendered = output.getvalue()
        result = state.get("_result")
        json.dumps(result)
        print(json.dumps({"id": request_id, "ok": True, "stdout": rendered, "result": result}), flush=True)
    except BaseException as exc:
        print(json.dumps({"id": request_id, "ok": False, "error": str(exc)}), flush=True)
`;

export type PythonSandboxResult = {
  ok: boolean;
  stdout: string;
  result: unknown;
  error: string | null;
};

export class PersistentPythonSandbox {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, { resolve: (value: PythonSandboxResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private closed = false;

  constructor(private readonly options: { timeoutMs?: number; maxOutputBytes?: number; pythonBin?: string } = {}) {
    this.child = spawn(options.pythonBin ?? process.env.OPENPOND_PYTHON_BIN ?? "python3", ["-I", "-S", "-u", "-c", WORKER_SOURCE], {
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    readline.createInterface({ input: this.child.stdout }).on("line", (line) => this.handleLine(line));
    this.child.once("error", (error) => this.failAll(error));
    this.child.once("exit", (code, signal) => {
      if (!this.closed) this.failAll(new Error(`Python sandbox exited with ${code ?? signal}.`));
    });
  }

  async run(code: string, signal?: AbortSignal): Promise<PythonSandboxResult> {
    if (this.closed) throw new Error("Python sandbox is closed.");
    if (Buffer.byteLength(code, "utf8") > 10_000) throw new Error("Python code exceeds the 10,000-byte limit.");
    if (signal?.aborted) throw abortError(signal);
    const id = `python_${randomUUID()}`;
    const result = new Promise<PythonSandboxResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Python sandbox execution timed out."));
        void this.close();
      }, this.options.timeoutMs ?? 1_500);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
    });
    const abort = () => {
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(abortError(signal));
      void this.close();
    };
    signal?.addEventListener("abort", abort, { once: true });
    this.child.stdin.write(`${JSON.stringify({ id, code })}\n`);
    try {
      return await result;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error("Python sandbox closed."));
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin.end();
    const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 500);
    timer.unref?.();
    await exited;
    clearTimeout(timer);
  }

  private handleLine(line: string): void {
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = typeof value.id === "string" ? value.id : "";
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    const stdout = typeof value.stdout === "string" ? value.stdout : "";
    const serialized = JSON.stringify(value.result ?? null);
    if (Buffer.byteLength(stdout + serialized, "utf8") > (this.options.maxOutputBytes ?? 16_384)) {
      pending.resolve({ ok: false, stdout: "", result: null, error: "Python sandbox output exceeded the byte limit." });
      return;
    }
    pending.resolve(value.ok === true
      ? { ok: true, stdout, result: value.result ?? null, error: null }
      : { ok: false, stdout: "", result: null, error: typeof value.error === "string" ? value.error : "Python execution failed." });
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function abortError(signal: AbortSignal | undefined): Error {
  const error = signal?.reason instanceof Error ? signal.reason : new Error("Python sandbox execution was cancelled.");
  error.name = "AbortError";
  return error;
}
