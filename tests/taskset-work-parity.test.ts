import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { createTaskEvaluationService } from "../apps/server/src/training/evaluation-service";
import type { ModelToolExecutionContext } from "../apps/server/src/openpond/model-tool-registry";
import { createWorkModelToolDefinitions } from "../apps/server/src/openpond/work-tool-registry";
import { resolveTasksetWorkAssets } from "../apps/server/src/training/taskset-work-assets";
import {
  createFixtureModelStream,
  createInMemoryTasksetWorkRuntime,
  materializeTasksetWorkFixture,
  validateTasksetWorkFixtureOutput,
} from "./helpers/taskset-work-fixtures";
import { withTrainingStore } from "./helpers/training-fixtures";

describe("interactive and automated Taskset Work parity", () => {
  test("uses the same assets, runtime profile, tools, and output handling", () =>
    withTrainingStore(async ({ store, directory }) => {
      const materialized = await materializeTasksetWorkFixture(
        directory,
        "multi_document",
      );
      await store.upsertTaskset(materialized.taskset);
      const task = materialized.taskset.tasks[0]!;
      const resolvedAssets = await resolveTasksetWorkAssets({
        storeDir: directory,
        taskset: materialized.taskset,
        task,
      });

      const interactive = createInMemoryTasksetWorkRuntime({
        storeDir: directory,
      });
      const definitions = createWorkModelToolDefinitions({
        executeWorkspaceTool: interactive.runtime.executeWorkspaceTool,
        inputs: resolvedAssets,
      });
      const session = await interactive.runtime.createSession({
        experience: "work",
      });
      const context = (
        callId: string,
        args: Record<string, unknown>,
      ): ModelToolExecutionContext => ({
        session,
        turnId: "turn_interactive_fixture",
        callId,
        args,
        provider: "openpond",
        model: "openpond-chat",
        mentionedApps: [],
        userPrompt: String(task.input.prompt),
        turnMetadata: {},
        signal: new AbortController().signal,
        workspaceDiffBaseline: null,
      });
      const environment = requiredDefinition(definitions, "work_environment");
      const write = requiredDefinition(definitions, "work_write_file");
      const save = requiredDefinition(definitions, "work_save_output");
      const stop = requiredDefinition(definitions, "work_stop");

      const environmentResult = await environment.execute(
        context("call_environment", {}),
      );
      const outputText = materialized.expectedOutputs.get(
        "proposal-workplan.json",
      );
      if (!outputText) throw new Error("Fixture output is missing.");
      const writeResult = await write.execute(
        context("call_write", {
          area: "outputs",
          path: "proposal-workplan.json",
          content: outputText,
        }),
      );
      const saveResult = await save.execute(
        context("call_save", {
          path: "proposal-workplan.json",
          suggestedName: "proposal-workplan.json",
          validation: [{
            kind: "structural",
            status: "passed",
            label: "Synthetic workplan schema",
          }],
        }),
      );
      const stopResult = await stop.execute(context("call_stop", {}));

      expect(environmentResult).toMatchObject({
        ok: true,
        data: {
          runtimeProfileId: "openpond-work-v1",
          executionBacked: true,
        },
      });
      expect(writeResult.ok).toBe(true);
      expect(saveResult).toMatchObject({
        ok: true,
        data: {
          outputRef: {
            kind: "file",
            contentType: "application/json",
          },
        },
      });
      expect(stopResult.ok).toBe(true);

      const automated = createInMemoryTasksetWorkRuntime({
        storeDir: directory,
      });
      const evaluation = createTaskEvaluationService({
        store,
        storeDir: directory,
        modelText: async () => "",
        modelStream: createFixtureModelStream({
          expectedOutputs: materialized.expectedOutputs,
        }),
        workRuntime: automated.runtime,
        validateWorkRequiredOutput: (input) =>
          validateTasksetWorkFixtureOutput({
            kind: "multi_document",
            requiredOutput: input.requiredOutput,
            artifactPath: input.artifactPath,
          }),
      });
      const execution = await evaluation.execute({
        tasksetId: materialized.taskset.id,
        taskId: task.id,
        model: {
          providerId: "openpond",
          modelId: "openpond-chat",
        },
        seed: 17,
        attempt: 0,
        resultId: "attempt_multi_document_parity",
      });

      const expectedHashes = task.assets?.map((asset) => asset.sha256) ?? [];
      const interactiveHashes = [...interactive.sandboxFiles.entries()]
        .filter(([file]) => file.startsWith("inputs/"))
        .map(([, bytes]) =>
          createHash("sha256").update(bytes).digest("hex")
        );
      expect(interactiveHashes).toEqual(expectedHashes);
      expect(execution.attempt.metadata).toMatchObject({
        runtimeProfileId: environmentResult.data?.runtimeProfileId,
        toolNames: materialized.taskset.environment.toolNames,
        assetHashes: expectedHashes,
      });
      expect(
        definitions
          .map((definition) => definition.name)
          .filter((name) =>
            materialized.taskset.environment.toolNames.includes(name)
          ),
      ).toEqual(materialized.taskset.environment.toolNames);
      expect(execution.attempt.output).toMatchObject({
        outputsPassed: true,
        requiredOutputs: [{
          path: "proposal-workplan.json",
          mediaType: "application/json",
          passed: true,
        }],
      });
      expect(execution.grade).toMatchObject({
        score: 1,
        passed: true,
        rewardEligible: true,
      });
      expect(interactive.actions.at(-1)).toBe("sandbox_stop");
      expect(automated.actions.at(-1)).toBe("sandbox_stop");
      expect(materialized.taskset.environment).toMatchObject({
        defaultTimeoutMs: 180_000,
        metadata: {
          maxToolTurns: 12,
          maxInputBytes: 10_000_000,
        },
      });
    }));
});

function requiredDefinition(
  definitions: ReturnType<typeof createWorkModelToolDefinitions>,
  name: string,
) {
  const definition = definitions.find((candidate) => candidate.name === name);
  if (!definition) throw new Error(`Work tool ${name} is missing.`);
  return definition;
}
