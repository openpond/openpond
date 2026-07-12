import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import type { GraderSpec, TaskAttemptResult, TaskDataRecord } from "@openpond/contracts";

type CustomVerifier = Extract<GraderSpec, { kind: "custom_verifier" }>;

export async function runSandboxedVerifier(input: {
  grader: CustomVerifier;
  task: TaskDataRecord;
  attempt: TaskAttemptResult;
  allowedRoot: string;
}): Promise<{ score: number; passed: boolean; feedback: string; evidenceRefs?: string[] }> {
  const root = await realpath(input.allowedRoot);
  const modulePath = await realpath(path.resolve(root, input.grader.module));
  if (modulePath !== root && !modulePath.startsWith(`${root}${path.sep}`)) throw new Error("Verifier module is outside the approved Taskset root.");
  const source = await readFile(modulePath, "utf8");
  assertSandboxableSource(source);
  const functionSource = verifierFunctionSource(source, input.grader.exportName);
  const context = vm.createContext(Object.freeze({
    structuredClone,
    JSON: Object.freeze(JSON),
    Math: Object.freeze(Math),
  }), { name: `openpond-verifier:${input.grader.id}`, codeGeneration: { strings: false, wasm: false } });
  const script = new vm.Script(`(${functionSource})`, { filename: path.basename(modulePath) });
  const verifier = script.runInContext(context, { timeout: Math.min(input.grader.timeoutMs, 5_000) }) as (value: unknown) => unknown;
  if (typeof verifier !== "function") throw new Error("Verifier export did not evaluate to a function.");
  const result = await withTimeout(
    Promise.resolve(verifier(structuredClone({ task: input.task, attempt: input.attempt }))),
    input.grader.timeoutMs,
  );
  return normalizeResult(result);
}

function assertSandboxableSource(source: string): void {
  const forbidden = /\b(?:import|require|process|globalThis|global|fetch|WebSocket|XMLHttpRequest|Deno|Bun|eval|Function)\b/;
  const match = forbidden.exec(source);
  if (match) throw new Error(`Verifier source contains forbidden capability: ${match[0]}.`);
  if (source.length > 100_000) throw new Error("Verifier source exceeds 100 KB.");
}

function verifierFunctionSource(source: string, exportName: string): string {
  const patterns = exportName === "default"
    ? [/export\s+default\s+(async\s+function[\s\S]*)$/m, /export\s+default\s+([\s\S]*)$/m]
    : [new RegExp(`export\\s+(?:const|let)\\s+${escapeRegExp(exportName)}\\s*=\\s*([\\s\\S]*?);?\\s*$`, "m"), new RegExp(`export\\s+(async\\s+)?function\\s+${escapeRegExp(exportName)}\\s*(\\([\\s\\S]*$)`, "m")];
  for (const pattern of patterns) {
    const match = pattern.exec(source.trim());
    if (!match) continue;
    if (exportName !== "default" && match.length === 3) return `${match[1] ?? ""}function ${exportName}${match[2]}`;
    return match[1]!.replace(/;\s*$/, "");
  }
  throw new Error(`Verifier must contain one standalone ESM function export named ${exportName}.`);
}

function normalizeResult(value: unknown): { score: number; passed: boolean; feedback: string; evidenceRefs?: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Verifier must return an object.");
  const record = value as Record<string, unknown>;
  const score = typeof record.score === "number" ? Math.max(0, Math.min(1, record.score)) : record.passed === true ? 1 : 0;
  return { score, passed: record.passed === true, feedback: typeof record.feedback === "string" ? record.feedback.slice(0, 20_000) : "Custom verifier completed.", evidenceRefs: Array.isArray(record.evidenceRefs) ? record.evidenceRefs.filter((item): item is string => typeof item === "string").slice(0, 10_000) : [] };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Verifier exceeded ${timeoutMs} ms.`)), timeoutMs);
    promise.then((value) => { clearTimeout(timeout); resolve(value); }, (error) => { clearTimeout(timeout); reject(error); });
  });
}
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
