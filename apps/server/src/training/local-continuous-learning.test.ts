import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { Session } from "@openpond/contracts";

import { SqliteStore } from "../store/store.js";
import {
  createLocalContinuousLearningService,
  nextDailyRunAt,
} from "./local-continuous-learning.js";
import type { TasksetAuthoringSkillArtifact } from "./task-authoring-skill.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

describe("local continuous-learning Saved Work", () => {
  test("keeps one immutable product definition and preserves user schedule settings", async () => {
    const { service, store } = await fixture();
    const first = await service.ensure({
      profileId: "default",
      scope: "personal",
      enabled: true,
      localTime: "03:15",
      timezone: "America/New_York",
    });
    const repeated = await service.ensure({
      profileId: "default",
      scope: "personal",
    });

    expect(repeated.id).toBe(first.id);
    expect(repeated.definitions).toHaveLength(1);
    expect(repeated.schedule).toMatchObject({
      id: first.schedule.id,
      enabled: true,
      localTime: "03:15",
      timezone: "America/New_York",
    });

    const changedModel = await service.ensure({
      profileId: "default",
      scope: "personal",
      model: {
        provider: "local_adapter",
        model: "device-model",
        reasoningEffort: "medium",
      },
    });
    expect(changedModel.definitions).toHaveLength(2);
    expect(changedModel.schedule.definitionId).toBe(changedModel.currentDefinitionId);
    expect(changedModel.schedule.localTime).toBe("03:15");
    expect(changedModel.definitions[0]?.model.model).toBe("openpond-chat");
    expect(changedModel.definitions[1]?.model.model).toBe("device-model");
    await store.close();
  });

  test("stores explicit per-conversation grant and revocation separately from schedule enablement", async () => {
    const { service, store } = await fixture();
    const session = conversation("conversation_1");
    await store.insertSessionAtFront(session);
    const granted = await service.setConversationConsent(session.id, {
      status: "granted",
      scope: "personal",
    });
    expect(granted.metadata?.continuousLearningConsent).toMatchObject({
      status: "granted",
      scope: "personal",
      revokedAt: null,
    });
    const revoked = await service.setConversationConsent(session.id, {
      status: "revoked",
      scope: "personal",
    });
    expect(revoked.metadata?.continuousLearningConsent).toMatchObject({
      status: "revoked",
      scope: "personal",
      revokedAt: expect.any(String),
    });
    expect(await service.list()).toEqual([]);
    await store.close();
  });

  test("computes the next local daily occurrence across daylight-saving time", () => {
    expect(nextDailyRunAt(
      "02:00",
      "America/New_York",
      new Date("2026-11-01T04:30:00.000Z"),
    )).toBe("2026-11-01T07:00:00.000Z");
  });
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "openpond-local-cl-"));
  directories.push(directory);
  const store = new SqliteStore(directory);
  const service = createLocalContinuousLearningService({
    store,
    skillArtifact: artifact(),
    createSession: async () => { throw new Error("not used"); },
    sendTurn: async () => { throw new Error("not used"); },
    interruptSessionTurn: async () => undefined,
    isClosing: () => false,
  });
  return { service, store };
}

function artifact(): TasksetAuthoringSkillArtifact {
  return {
    schemaVersion: 1,
    artifactVersion: "openpond.taskset-authoring.test.1",
    skillName: "openpond-taskset-authoring",
    source: {
      repository: "openpond/openpond",
      commit: "test",
      path: "apps/cli/skills/openpond-taskset-authoring",
    },
    files: [],
    bundle: "test skill",
    contentHash: "a".repeat(64),
  };
}

function conversation(id: string): Session {
  const timestamp = "2026-08-03T12:00:00.000Z";
  return {
    id,
    experience: "chat",
    provider: "openpond",
    modelRef: null,
    openPondCommandAccessMode: "disabled",
    title: "Eligible conversation",
    appId: null,
    appName: null,
    cwd: null,
    codexThreadId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "idle",
    pinned: false,
    archived: false,
    order: 0,
  };
}
