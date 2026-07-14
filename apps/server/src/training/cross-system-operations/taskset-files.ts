import { CROSS_SYSTEM_TOOL_CONTRACT_HASH, CROSS_SYSTEM_TOOL_CONTRACT_VERSION, type GeneratedTaskFile } from "@openpond/contracts";
import type { CrossSystemTask, CrossSystemWorld } from "./types.js";

export function crossSystemGeneratedTaskFiles(input: { worlds: CrossSystemWorld[]; tasks: CrossSystemTask[] }): GeneratedTaskFile[] {
  return [
    {
      path: "environment/taskset.ts",
      role: "environment",
      content: [
        `export const toolContractHash = ${JSON.stringify(CROSS_SYSTEM_TOOL_CONTRACT_HASH)};`,
        "export const lifecycle = ['create', 'reset', 'step', 'grade', 'cleanup'];",
        "export const limits = { maxTurns: 15, networkPolicy: 'none', productionCredentials: false };",
        "export function assertEnvironmentContract(candidate) {",
        "  if (!candidate || candidate.toolContractHash !== toolContractHash) throw new Error('Cross-System Operations tool contract mismatch.');",
        "  return { ok: true, toolContractHash };",
        "}",
        "",
      ].join("\n"),
    },
    {
      path: "environment/tool-contract.json",
      role: "environment",
      content: `${JSON.stringify({ schemaVersion: CROSS_SYSTEM_TOOL_CONTRACT_VERSION, toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH }, null, 2)}\n`,
    },
    {
      path: "environment/worlds.json",
      role: "environment",
      content: `${JSON.stringify(input.worlds, null, 2)}\n`,
    },
    {
      path: "environment/tasks.json",
      role: "environment",
      content: `${JSON.stringify(input.tasks, null, 2)}\n`,
    },
    {
      path: "graders/cross-system-verifier.ts",
      role: "verifier",
      content: [
        "export function verifyCrossSystem(value) {",
        `  const toolContractHash = ${JSON.stringify(CROSS_SYSTEM_TOOL_CONTRACT_HASH)};`,
        "  if (value.infrastructureError) return { passed: false, score: 0, feedback: 'Infrastructure failure; reward is ineligible.', evidenceRefs: [] };",
        "  const expected = value.expectedOutput && value.expectedOutput.text;",
        "  const actual = value.output && value.output.text;",
        "  if (typeof expected !== 'string' || typeof actual !== 'string') return { passed: false, score: 0, feedback: 'Missing typed ANSWER text.', evidenceRefs: [] };",
        "  const parse = (text) => { const match = /^\\s*ANSWER:\\s*([^]*?)\\s*$/.exec(text); if (!match) return null; try { return JSON.parse(match[1]); } catch { return null; } };",
        "  const normalize = (item) => Array.isArray(item) ? item.map(normalize) : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, normalize(child)])) : typeof item === 'string' ? item.normalize('NFC').trim() : item;",
        "  const expectedAnswer = parse(expected); const actualAnswer = parse(actual);",
        "  const passed = actualAnswer !== null && JSON.stringify(normalize(actualAnswer)) === JSON.stringify(normalize(expectedAnswer));",
        "  return { passed, score: passed ? 1 : 0, feedback: passed ? `Exact answer matched ${toolContractHash}.` : 'Exact answer mismatch or parse failure.', evidenceRefs: [] };",
        "}",
        "",
      ].join("\n"),
    },
    {
      path: "fixtures/adversarial.json",
      role: "fixture",
      content: `${JSON.stringify({ toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH, labels: ["positive", "negative", "boundary", "adversarial", "prompt_injection", "infrastructure_failure"] }, null, 2)}\n`,
    },
  ];
}
