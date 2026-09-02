import { z } from "zod";

import { contentHash } from "./hash.js";
import { createContinualBenchPanelAllocations } from "./releases.js";
import { createContinualBenchSplit, type ContinualBenchPassAllocation, type ContinualBenchSourceTask } from "./split.js";

export const CONTINUAL_BENCH_PREDECESSOR_COMMAND_INVENTORY = Object.freeze([
  "canonical-customer resolution",
  "issue-family ledger",
  "exact and similarity leakage audit",
  "family-level panel allocation",
  "correction release construction",
  "weekly correction union",
  "full training-eligible pool resolution",
  "portable report publication",
]);

const GoldenFixtureSchema = z.object({
  schemaVersion: z.literal("openpond.continualBenchGoldenMigration.v1"),
  source: z.object({ repository: z.string(), commit: z.string() }).strict(),
  seed: z.string().min(1),
  correctionSelection: z.enum(["stable_hash", "minimize_prompt_similarity"]),
  expectedSplitHash: z.string().regex(/^[a-f0-9]{64}$/),
  expectedLeakageHash: z.string().regex(/^[a-f0-9]{64}$/),
  allocations: z.array(z.object({ id: z.string(), familyId: z.string(), contentHash: z.string().regex(/^[a-f0-9]{64}$/), prompt: z.string().optional(), criticalInvariantIds: z.array(z.string()).optional(), passLabel: z.string(), panelRole: z.enum(["correction", "sibling_verification"]), optimizerEligible: z.boolean() }).strict()),
  families: z.array(z.object({ familyId: z.string(), passLabel: z.string(), correctionTaskIds: z.array(z.string()), siblingTaskIds: z.array(z.string()) }).strict()),
}).strict();

export type ContinualBenchGoldenMigrationFixture = z.infer<typeof GoldenFixtureSchema>;

export function reproduceGoldenSplit(fixtureValue: unknown) {
  const fixture = GoldenFixtureSchema.parse(fixtureValue);
  const tasks: ContinualBenchSourceTask[] = fixture.allocations.map((entry) => ({ id: entry.id, familyId: entry.familyId, contentHash: entry.contentHash, prompt: entry.prompt, criticalInvariantIds: entry.criticalInvariantIds }));
  const passes: ContinualBenchPassAllocation[] = fixture.families.map((family) => ({ label: family.passLabel, familyIds: [family.familyId] }));
  const split = createContinualBenchSplit({ tasks, passes, seed: fixture.seed, correctionSelection: fixture.correctionSelection });
  return { fixture, split, panels: createContinualBenchPanelAllocations(split), reproductionHash: contentHash({ split, panels: createContinualBenchPanelAllocations(split) }) };
}

export function verifyGoldenMigrationFixture(fixtureValue: unknown): boolean {
  const { fixture, split } = reproduceGoldenSplit(fixtureValue);
  return split.contentHash === fixture.expectedSplitHash
    && JSON.stringify(split.families) === JSON.stringify(fixture.families);
}
