import { describe, expect, it } from "vitest";

import { ModelProjectSchema } from "@openpond/contracts";
import {
  applyProjectTrainingSetup,
  newDraft,
  newProject,
} from "../apps/web/src/components/labs/model-run-editor-helpers";

const HASH = "a".repeat(64);

describe("Model Project current training setup", () => {
  it("starts empty on a new Project without creating another product object", () => {
    const project = newProject("personal", "Improve support quality");
    expect(project.trainingSetup).toEqual({
      tasksetRef: null,
      harnessRelease: null,
      tasksetRelease: null,
      baseModel: null,
      method: null,
      destinationId: null,
      managedRolloutPlacement: "remote",
      runPreset: null,
      recipe: null,
      preferredMaximumSpendUsd: null,
      preferredRetentionDays: null,
    });
  });

  it("normalizes older stored Projects with an empty current setup", () => {
    const project = ModelProjectSchema.parse({
      schemaVersion: "openpond.modelProject.v1",
      id: "model-1",
      profileId: "personal",
      revision: 1,
      name: "Support model",
      objective: null,
      defaultBaseModel: null,
      defaultDestinationId: null,
      hosted: null,
      tasksetSyncs: [],
      createdAt: "2026-08-26T20:00:00.000Z",
      updatedAt: "2026-08-26T20:00:00.000Z",
    });
    expect(project.trainingSetup.tasksetRef).toBeNull();
    expect(project.trainingSetup.method).toBeNull();
  });

  it("resumes the Project setup through the temporary lifecycle bridge", () => {
    const project = newProject("personal", null, "model-1", "Support model");
    project.trainingSetup = {
      ...project.trainingSetup,
      tasksetRef: { id: "taskset-1", revision: 2, contentHash: HASH },
      method: "grpo",
      destinationId: "openpond_managed",
      managedRolloutPlacement: "remote",
      runPreset: "standard",
    };
    const input = applyProjectTrainingSetup(
      newDraft("personal", project.id),
      project,
    );
    expect(input.tasksetRef).toEqual(project.trainingSetup.tasksetRef);
    expect(input.method).toBe("grpo");
    expect(input.destinationId).toBe("openpond_managed");
    expect(input.status).toBe("draft");
  });
});
