import { assertContentHash, contentHash } from "@openpond/harness";
import {
  HarnessReleaseSchema,
  type HarnessRelease,
} from "@openpond/harness";
import {
  createHarnessCompatibilityReceipt,
  type HarnessCompatibilityReceipt,
} from "./runs.js";
import {
  TasksetReleaseSchema,
  type TasksetRelease,
} from "./tasksets.js";

export function createVerifiedHarnessCompatibilityReceipt(input: {
  id: string;
  baseHarnessRelease: HarnessRelease;
  candidateHarnessRelease: HarnessRelease;
  tasksetRelease: TasksetRelease;
  metadata?: Record<string, unknown>;
}): HarnessCompatibilityReceipt {
  const base = HarnessReleaseSchema.parse(input.baseHarnessRelease);
  const candidate = HarnessReleaseSchema.parse(input.candidateHarnessRelease);
  const taskset = TasksetReleaseSchema.parse(input.tasksetRelease);
  assertContentHash(base, "Base Harness release");
  assertContentHash(candidate, "Candidate Harness release");
  assertContentHash(taskset, "Taskset release");

  requireSameContract("lifecycle", base.lifecycle, candidate.lifecycle);
  requireSameContract("tool", base.tools, candidate.tools);
  requireSameContract(
    "grader interface",
    base.graderInterface,
    candidate.graderInterface,
  );

  const environmentTools = new Set(taskset.tools.map((tool) => tool.name));
  const unsupportedTools = base.tools
    .map((tool) => tool.name)
    .filter((name) => !environmentTools.has(name));
  if (unsupportedTools.length) {
    throw new Error(
      `Harness compatibility failed: Taskset Environment does not provide ${unsupportedTools.join(", ")}.`,
    );
  }

  return createHarnessCompatibilityReceipt({
    schemaVersion: "openpond.harnessCompatibility.v1",
    id: input.id,
    baseHarnessRelease: { id: base.id, contentHash: base.contentHash },
    candidateHarnessRelease: {
      id: candidate.id,
      contentHash: candidate.contentHash,
    },
    tasksetRelease: { id: taskset.id, contentHash: taskset.contentHash },
    environmentHash: contentHash(taskset.environment),
    toolContractHash: contentHash(taskset.tools),
    policyHash: contentHash(taskset.policy),
    graderInterfaceHash: contentHash({
      harness: base.graderInterface,
      taskset: taskset.graders,
    }),
    metadata: input.metadata ?? {},
  });
}

function requireSameContract(
  label: string,
  base: unknown,
  candidate: unknown,
): void {
  if (contentHash(base) !== contentHash(candidate)) {
    throw new Error(
      `Harness compatibility failed: ${label} contract changed.`,
    );
  }
}
