import { CROSS_SYSTEM_TOOL_CONTRACT_HASH, CROSS_SYSTEM_TOOL_CONTRACT_VERSION, type GeneratedTaskFile } from "@openpond/contracts";
import type { CrossSystemTask, CrossSystemWorld } from "./types.js";

const MAX_GENERATED_FILE_CHARACTERS = 240_000;

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
    ...portableJsonCollection({
      name: "worlds",
      items: input.worlds,
      itemId: (world) => world.id,
    }),
    ...portableJsonCollection({
      name: "tasks",
      items: input.tasks,
      itemId: (task) => task.worldId,
    }),
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

function portableJsonCollection<T>(input: {
  name: "worlds" | "tasks";
  items: T[];
  itemId: (item: T) => string;
}): GeneratedTaskFile[] {
  const combined = `${JSON.stringify(input.items, null, 2)}\n`;
  if (combined.length <= MAX_GENERATED_FILE_CHARACTERS) {
    return [{
      path: `environment/${input.name}.json`,
      role: "environment",
      content: combined,
    }];
  }
  const groups = new Map<string, T[]>();
  for (const item of input.items) {
    const key = safeSegment(input.itemId(item));
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  const files = [...groups.entries()].map(([key, items], index) => {
    const content = `${JSON.stringify(items, null, 2)}\n`;
    if (content.length > MAX_GENERATED_FILE_CHARACTERS) {
      throw new Error(
        `Cross-System ${input.name} shard ${key} exceeds the portable Taskset file limit.`,
      );
    }
    return {
      path: `environment/${input.name}/${String(index + 1).padStart(3, "0")}-${key}.json`,
      role: "environment" as const,
      content,
    };
  });
  return [
    {
      path: `environment/${input.name}.json`,
      role: "environment",
      content: `${JSON.stringify({
        schemaVersion: "openpond.crossSystemCollection.v1",
        count: input.items.length,
        files: files.map((file) => file.path),
      }, null, 2)}\n`,
    },
    ...files,
  ];
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 160);
}
