import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { GraderSpec, TaskAttemptResult, TaskDataRecord } from "@openpond/contracts";
import { executeJavaScriptVerifierInWorker } from "@openpond/evals/javascript-verifier/node";

type CustomVerifier = Extract<GraderSpec, { kind: "custom_verifier" }>;

export async function runSandboxedVerifier(input: {
  grader: CustomVerifier;
  task: TaskDataRecord;
  attempt: TaskAttemptResult;
  allowedRoot: string;
  signal?: AbortSignal;
}): Promise<{ score: number; passed: boolean; feedback: string; evidenceRefs?: string[] }> {
  const root = await realpath(input.allowedRoot);
  const modulePath = await realpath(path.resolve(root, input.grader.module));
  if (modulePath !== root && !modulePath.startsWith(`${root}${path.sep}`)) throw new Error("Verifier module is outside the approved Taskset root.");
  const source = await readFile(modulePath, "utf8");
  return executeJavaScriptVerifierInWorker({
    source, exportName: input.grader.exportName, timeoutMs: input.grader.timeoutMs, signal: input.signal,
    value: {
      task: input.task, attempt: input.attempt, input: input.task.input,
      expectedOutput: input.task.expectedOutput, output: input.attempt.output,
      infrastructureError: input.attempt.infrastructureError,
    },
  });
}
