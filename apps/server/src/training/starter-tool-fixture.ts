import type { GraderFixture, TaskDataRecord, Taskset } from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";
import { ModelStarterToolFixtureScriptSchema } from "openpond-sdk/model-starters";
import type { SqliteStore } from "../store/store.js";
import { runStarterToolAttempt } from "./starter-tool-attempt.js";

/** Authored scripts execute the real world; they never provide a final state. */
export async function runStarterToolFixture(input: { store: SqliteStore; storeDir: string; taskset: Taskset; task: TaskDataRecord; fixture: GraderFixture }) {
  const script = ModelStarterToolFixtureScriptSchema.parse(input.fixture.metadata.toolScript);
  let step = 0;
  return runStarterToolAttempt({
    store: input.store, storeDir: input.storeDir, taskset: input.taskset,
    policySource: "fixture", timestamp: () => new Date().toISOString(),
    resultId: `tool_fixture_${contentHash({ taskset: input.taskset.contentHash, fixture: input.fixture, time: Date.now() }).slice(0, 32)}`,
    attemptInput: { tasksetId: input.taskset.id, task: input.task, model: { providerId: "openpond", modelId: "scripted-tool-policy" }, seed: 0, attempt: 0 },
    stream: async function* () {
      const action = script.actions[step++];
      if (action) yield { toolCalls: [{ id: `fixture-call-${step}`, type: "function", function: { name: action.name, arguments: JSON.stringify(action.arguments) } }] };
      else yield { text: JSON.stringify(input.fixture.output) };
    },
  });
}
