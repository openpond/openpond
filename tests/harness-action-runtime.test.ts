import type {
  HarnessBundleProjection,
  HarnessExecutionBundleManifest,
  ModelAction,
} from "@openpond/contracts";
import {
  executeHarnessActionBinding,
  studentHarnessActionTools,
} from "@openpond/training-sdk";
import { contentHash } from "@openpond/taskset-sdk";
import { describe, expect, test, vi } from "vitest";

import { createHarnessFixture } from "./helpers/portable-training-fixtures.js";

describe("Harness Agent action runtime", () => {
  test("projects direct tools to the student and executes them through the pinned environment binding", async () => {
    const release = createHarnessFixture().release;
    const student = manifest(release, "student");
    const environment = manifest(release, "environment");

    expect(studentHarnessActionTools(student)).toEqual([
      {
        actionId: "profile.fixture.inspect",
        name: "agent_fixture_inspect",
        description: "Inspect the fixture state.",
        inputSchema: release.actionBindings![0]!.inputSchema,
        sideEffect: "read",
      },
    ]);

    const execute = vi.fn(async ({ binding, arguments: args }) => ({
      output: {
        ok: true,
        actionId: binding.actionId,
        inspectedId: args.id,
      },
    }));
    const action = modelAction({
      id: "student-action-1",
      turn: 2,
      name: "agent_fixture_inspect",
      arguments: { id: "campaign-17" },
    });
    const observation = await executeHarnessActionBinding({
      manifest: environment,
      action,
      execute,
    });

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({
          agentRelease: release.actionBindings![0]!.agentRelease,
          runtimeBindingId: "profile-action-runtime",
          capabilityReceiptHash:
            release.actionBindings![0]!.capabilityReceiptHash,
        }),
        arguments: { id: "campaign-17" },
        action,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(observation).toMatchObject({
      actionId: "student-action-1",
      turn: 2,
      terminal: false,
      output: {
        ok: true,
        actionId: "profile.fixture.inspect",
        inspectedId: "campaign-17",
      },
      artifactRefs: [],
    });
    const { contentHash: observationHash, ...observationContent } = observation;
    expect(observationHash).toBe(contentHash(observationContent));
  });

  test("rejects unbound tools and refuses execution from the student projection", async () => {
    const release = createHarnessFixture().release;
    const execute = vi.fn();
    await expect(
      executeHarnessActionBinding({
        manifest: manifest(release, "environment"),
        action: modelAction({
          id: "student-action-2",
          turn: 0,
          name: "unbound_tool",
          arguments: {},
        }),
        execute,
      }),
    ).rejects.toThrow(/not bound/i);
    await expect(
      executeHarnessActionBinding({
        manifest: manifest(release, "student"),
        action: modelAction({
          id: "student-action-3",
          turn: 0,
          name: "agent_fixture_inspect",
          arguments: { id: "campaign-17" },
        }),
        execute,
      }),
    ).rejects.toThrow(/can only execute/i);
    expect(execute).not.toHaveBeenCalled();
  });

  test("privately injects the episode case and never exposes it in the student tool schema", async () => {
    const fixture = createHarnessFixture().release;
    const release = {
      ...fixture,
      actionBindings: fixture.actionBindings!.map((binding) => ({
        ...binding,
        episodeArgumentBindings: [
          { argument: "scenarioId", source: "case_id" as const },
        ],
      })),
    };
    const tools = studentHarnessActionTools(manifest(release, "student"));
    expect(tools[0]!.inputSchema).not.toHaveProperty(
      "properties.scenarioId",
    );

    const execute = vi.fn(async () => ({ output: { ok: true } }));
    await executeHarnessActionBinding({
      manifest: manifest(release, "environment"),
      action: modelAction({
        id: "student-action-private-case",
        turn: 1,
        name: "agent_fixture_inspect",
        arguments: { id: "campaign-17" },
      }),
      episode: { caseId: "cmo_train_1" },
      execute,
    });

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        arguments: {
          id: "campaign-17",
          scenarioId: "cmo_train_1",
        },
      }),
    );
  });

  test("rejects student-supplied or missing private episode selectors", async () => {
    const fixture = createHarnessFixture().release;
    const release = {
      ...fixture,
      actionBindings: fixture.actionBindings!.map((binding) => ({
        ...binding,
        episodeArgumentBindings: [
          { argument: "scenarioId", source: "case_id" as const },
        ],
      })),
    };
    const execute = vi.fn();
    const environment = manifest(release, "environment");

    await expect(
      executeHarnessActionBinding({
        manifest: environment,
        action: modelAction({
          id: "student-action-injected-case",
          turn: 1,
          name: "agent_fixture_inspect",
          arguments: {
            id: "campaign-17",
            scenarioId: "cmo_frozen_eval_8",
          },
        }),
        episode: { caseId: "cmo_train_1" },
        execute,
      }),
    ).rejects.toThrow(/caller-supplied episode argument/i);
    await expect(
      executeHarnessActionBinding({
        manifest: environment,
        action: modelAction({
          id: "student-action-missing-case",
          turn: 1,
          name: "agent_fixture_inspect",
          arguments: { id: "campaign-17" },
        }),
        execute,
      }),
    ).rejects.toThrow(/requires a privately bound episode case/i);
    expect(execute).not.toHaveBeenCalled();
  });
});

function manifest(
  release: ReturnType<typeof createHarnessFixture>["release"],
  projection: HarnessBundleProjection,
): HarnessExecutionBundleManifest {
  const content = {
    schemaVersion: "openpond.harnessExecutionBundle.v1" as const,
    harnessRelease: {
      id: release.id,
      contentHash: release.contentHash,
    },
    resolvedGraphHash: contentHash(release.children),
    target: {
      adapterId: projection === "student" ? "student-runtime" : "local-harness",
      projection,
      runtimeVersion: "1",
    },
    files: [],
    actionBindings: release.actionBindings,
    secretDeclarations: [],
  };
  return {
    ...content,
    contentHash: contentHash(content),
  };
}

function modelAction(
  input: Omit<ModelAction, "kind" | "content" | "contentHash">,
): ModelAction {
  const content = {
    ...input,
    kind: "tool_call" as const,
    content: null,
  };
  return {
    ...content,
    contentHash: contentHash(content),
  };
}
