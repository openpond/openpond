import { expect, test } from "vitest";
import { executeJavaScriptVerifier } from "../src/javascript-verifier.js";
import { executeJavaScriptVerifierInProcess, executeJavaScriptVerifierInWorker } from "@openpond/evals/javascript-verifier/node";

const options = { timeoutMs: 1_000, value: { input: { question: "2 + 2" }, output: { answer: 4 }, expectedOutput: { answer: 4 }, evaluatorContext: { privateAnswer: 4 } } };

// A source checker can require subprocess/filesystem semantics even when its
// wrapper also runs in an interpreter. Never accept that accidental success.
test.each([executeJavaScriptVerifier, executeJavaScriptVerifierInWorker, executeJavaScriptVerifierInProcess])(
  "rejects a sandbox-process requirement before isolated verifier execution", async execute => {
    await expect(execute({ ...options, runtime: "sandbox_process",
      source: "export function verify() { return { score: 1, passed: true, feedback: 'Wrong runtime' }; }",
    })).rejects.toThrow("verifier_sandbox_process_required");
  },
);

// Authored code is an executable capability boundary: process escape, runaway
// loops, hostile serialization and async jobs must all stay inside the interpreter.
test("executes ESM and async verifier functions without exposing host capabilities", async () => {
  expect(await executeJavaScriptVerifier({ ...options, source: "export async function verify({ output, expectedOutput }) { await Promise.resolve(); const passed = output.answer === expectedOutput.answer; return { score: Number(passed), passed, feedback: 'Compared answers' }; }" })).toMatchObject({ score: 1, passed: true });
  expect(await executeJavaScriptVerifier({ ...options, source: "export function verify() { const host = Function('return this')(); const passed = ['process','fetch','require','WebSocket','setTimeout'].every(key => !(key in host)); return { score: Number(passed), passed, feedback: 'No host APIs' }; }" })).toMatchObject({ score: 1, passed: true });
  await expect(executeJavaScriptVerifier({ ...options, source: "import fs from 'node:fs'; export function verify() { return fs.readFileSync('/etc/passwd'); }" })).rejects.toThrow();
  await expect(executeJavaScriptVerifier({ ...options, timeoutMs: 40, source: "export function verify() { for (;;) {} }" })).rejects.toThrow();
  await expect(executeJavaScriptVerifier({ ...options, timeoutMs: 40, source: "export async function verify() { for (;;) await Promise.resolve(); }" })).rejects.toThrow();
  await expect(executeJavaScriptVerifier({ ...options, timeoutMs: 40, source: "export function verify() { return { toJSON() { for (;;) {} } }; }" })).rejects.toThrow();
  await expect(executeJavaScriptVerifier({ ...options, source: "export function verify() { return { score: 4, passed: true, feedback: 'Invalid score' }; }" })).rejects.toThrow();
  await expect(executeJavaScriptVerifier({ ...options, source: "export function verify() { return new Promise(() => {}); }" })).rejects.toThrow("verifier_unresolved_promise");
  expect(await executeJavaScriptVerifier({ ...options, source: "export function verify() { return { score: 0, passed: false, feedback: 'Runtime still healthy' }; }" })).toMatchObject({ score: 0, passed: false });
});
