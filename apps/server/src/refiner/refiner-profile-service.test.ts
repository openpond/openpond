import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { inspectRefinerProfile, rollbackRefinerRelease, updateRefinerProfile } from "./refiner-profile-service.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("Refiner profile service", () => {
  test("creates immutable adjacent releases and can roll back", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openpond-refiner-"));
    roots.push(root);
    const initial = await inspectRefinerProfile(root);
    const draft = await updateRefinerProfile(root, {
      profile: { ...initial.currentRelease.profile, version: "draft" },
      activate: false,
      reason: "Exercise draft authoring.",
      actor: "test",
      authoringSkillHash: null,
    });
    expect(draft.binding.release).toEqual(initial.binding.release);
    expect(draft.transitions[0]).toMatchObject({ operation: "update", bindingChanged: false });
    const repeatedDraft = await updateRefinerProfile(root, {
      profile: { ...initial.currentRelease.profile, version: "draft" },
      activate: false,
      reason: "Exercise draft authoring.",
      actor: "test",
      authoringSkillHash: null,
    });
    expect(repeatedDraft.releases).toHaveLength(2);
    expect(repeatedDraft.transitions).toHaveLength(2);
    const changed = await updateRefinerProfile(root, {
      profile: {
        ...initial.currentRelease.profile,
        version: "2",
        instructions: [{ id: "pdf-errors", text: "Treat failures that prevent reading a requested PDF as material review evidence." }],
      },
      activate: true,
      reason: "Exercise profile authoring.",
      actor: "test",
      authoringSkillHash: null,
    });
    expect(changed.binding.release.contentHash).not.toBe(initial.binding.release.contentHash);
    expect(changed.releases).toHaveLength(3);
    const rolledBack = await rollbackRefinerRelease(root, {
      release: initial.binding.release,
      reason: "Exercise rollback.",
      actor: "test",
    });
    expect(rolledBack.binding.release).toEqual(initial.binding.release);
    expect(rolledBack.transitions[0]?.operation).toBe("rollback");
  });
});
