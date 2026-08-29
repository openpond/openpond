import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  managedStructuredOutputContract,
  preferenceCalibrationSourceHash,
} from "../apps/server/src/training/managed-rl-calibration";

describe("Managed RL preference calibration", () => {
  test("projects a complete structured-output contract before hashing the request", () => {
    const schema = {
      type: "object",
      properties: {
        traits: {
          type: "object",
          properties: {
            top: { type: "string" },
            background: { type: "string" },
          },
        },
      },
    };
    const contract = managedStructuredOutputContract({
      mode: "structured_json",
      jsonSchema: schema,
    });

    expect(contract).toEqual({
      kind: "structured_json_v1",
      schema,
      schemaHash: createHash("sha256")
        .update(JSON.stringify({
          properties: {
            traits: {
              properties: {
                background: { type: "string" },
                top: { type: "string" },
              },
              type: "object",
            },
          },
          type: "object",
        }))
        .digest("hex"),
    });
  });

  test("keeps text-only calibration tasks explicitly unstructured", () => {
    expect(managedStructuredOutputContract({ mode: "text" })).toBeNull();
    expect(managedStructuredOutputContract(null)).toBeNull();
  });

  test("keeps one calibration source stable across mutable release bindings", () => {
    const source = {
      schemaVersion: "openpond.taskset.v1",
      id: "taskset-quality",
      revision: 2,
      status: "published",
      contentHash: "a".repeat(64),
      updatedAt: "2026-08-29T00:00:00.000Z",
      preferenceComparison: null,
      profileId: "default",
      tasks: [{ id: "task-1", input: { prompt: "royal duck" } }],
      environment: { kind: "chat" },
      policy: { maxTurns: 1 },
      metadata: { qualityPlanVersion: 2 },
    };
    const rebound = {
      ...source,
      revision: 9,
      status: "qualified",
      contentHash: "b".repeat(64),
      updatedAt: "2026-08-29T01:00:00.000Z",
      preferenceComparison: {
        releaseId: "comparison-r8",
        releaseHash: "c".repeat(64),
      },
    };

    expect(preferenceCalibrationSourceHash(rebound)).toBe(
      preferenceCalibrationSourceHash(source),
    );
    expect(
      preferenceCalibrationSourceHash({
        ...rebound,
        tasks: [{ id: "task-1", input: { prompt: "cyber duck" } }],
      }),
    ).not.toBe(preferenceCalibrationSourceHash(source));
  });
});
