import { contentHash, sha256 } from "@openpond/harness";

export type ManagedStructuredOutputContract = {
  kind: "structured_json_v1";
  schema: Record<string, unknown>;
  schemaHash: string;
};

export function managedStructuredOutputContract(
  value: unknown,
): ManagedStructuredOutputContract | null {
  const contract = record(value);
  if (contract.mode !== "structured_json") return null;
  const schema = record(contract.jsonSchema);
  if (!Object.keys(schema).length) return null;
  return {
    kind: "structured_json_v1",
    schema,
    schemaHash: sha256(JSON.stringify(compactCanonicalValue(schema))),
  };
}

export function preferenceCalibrationSourceHash(value: unknown): string {
  const taskset = record(value);
  return contentHash({
    schemaVersion: "openpond.preferenceCalibrationSource.v1",
    taskset: {
      schemaVersion: taskset.schemaVersion,
      id: taskset.id,
      profileId: taskset.profileId,
      profileRelease: taskset.profileRelease,
      name: taskset.name,
      objective: taskset.objective,
      purpose: taskset.purpose,
      benchmark: taskset.benchmark,
      sourceRefs: taskset.sourceRefs,
      policy: taskset.policy,
      environment: taskset.environment,
      capabilities: taskset.capabilities,
      metrics: taskset.metrics,
      tasks: taskset.tasks,
      graders: taskset.graders,
      graderFixtures: taskset.graderFixtures,
      authoringProvenance: taskset.authoringProvenance,
      metadata: taskset.metadata,
    },
  });
}

function compactCanonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactCanonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, compactCanonicalValue(child)]),
  );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
