import path from "node:path";
import type { Session, TaskCreationSnapshot, Taskset, TrainingSourceRef, TrainingStateResponse } from "@openpond/contracts";
import type { DesktopHarness } from "../../scripts/desktop-harness/types";
import { registerScriptedOpenPondModel, reloadRenderer, waitForAssistantOutput, waitForCompletedTurn, waitForRendererCondition } from "./helpers";

export function scriptedTrainingModel(_suffix: string) { return { providerId: "openpond" as const, modelId: "openpond-scripted-chat-two-turns" }; }

export async function initializeTrainingProfile(harness: DesktopHarness) {
  return harness.api.fetchJson("/v1/profile/init", { method: "POST", body: { repoPath: path.join(harness.artifactsDir, "profile-repo"), profile: "default", template: "blank-agent", force: true } });
}

export async function createTrainingChat(harness: DesktopHarness, modelRef: ReturnType<typeof scriptedTrainingModel>, title: string, prompt: string) {
  const session = await harness.api.createSession<Session>({ provider: "openpond", modelRef, title, cwd: harness.repoRoot });
  await harness.api.createTurn(session.id, { prompt, modelRef });
  const output = `scripted turn 1 response for: ${prompt.slice(0, 80)}`;
  const delta = await waitForAssistantOutput(harness, session.id, output, `${title} assistant output`);
  await waitForCompletedTurn(harness, session.id, delta, `${title} completion`);
  return session;
}

export async function addTrainingSource(harness: DesktopHarness, sessionId: string) {
  return harness.api.fetchJson<TrainingSourceRef>("/v1/training/sources", { method: "POST", body: { profileId: "default", sessionId } });
}

export async function materializeTasksetFromSessions(harness: DesktopHarness, sessions: Session[]) {
  const sources = await Promise.all(sessions.map((session) => addTrainingSource(harness, session.id)));
  const creation = await harness.api.fetchJson<TaskCreationSnapshot>("/v1/training/task-creations", { method: "POST", body: { profileId: "default", sourceIds: sources.map((source) => source.id), surface: "bulk_selection", mode: "defaults", objective: "Reproduce the approved scripted workflow.", analysisModel: null } });
  if (creation.state !== "awaiting_materialization_approval") throw new Error(`Unexpected Task Creator state: ${creation.state}`);
  const ready = await harness.api.fetchJson<TaskCreationSnapshot>(`/v1/training/task-creations/${creation.id}/materialize`, { method: "POST", body: { approved: true } });
  if (!ready.materializedTasksetId) throw new Error("Task Creator did not materialize a Taskset.");
  const state = await trainingState(harness);
  const taskset = state.tasksets.find((item) => item.id === ready.materializedTasksetId);
  if (!taskset) throw new Error("Materialized Taskset is missing from Training state.");
  return { sources, creation: ready, taskset };
}

export async function baselineTaskset(harness: DesktopHarness, taskset: Taskset, modelRef: ReturnType<typeof scriptedTrainingModel>) {
  await harness.api.fetchJson("/v1/training/baseline", { method: "POST", body: { tasksetId: taskset.id, models: [modelRef], seeds: [0], attemptsPerTask: 1 } });
  const state = await trainingState(harness);
  const updated = state.tasksets.find((item) => item.id === taskset.id);
  if (!updated?.readiness?.ready) throw new Error(`Taskset is not ready: ${updated?.readiness?.blockers.map((item) => item.code).join(", ")}`);
  return updated;
}

export async function trainingState(harness: DesktopHarness) {
  return harness.api.fetchJson<TrainingStateResponse>("/v1/training", { query: { profileId: "default" } });
}

export async function openTrainingPage(harness: DesktopHarness) {
  await reloadRenderer(harness);
  await waitForRendererCondition(harness, `(() => { const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Training'); if (!(button instanceof HTMLButtonElement)) return false; button.click(); return true; })()`, "Training navigation");
  await harness.renderer.assertText("Start in any chat with /train", { label: "Training page" });
}

export async function registerTrainingModel(harness: DesktopHarness, suffix: string) {
  const model = scriptedTrainingModel(suffix);
  await registerScriptedOpenPondModel(harness, model);
  return model;
}

export function fixtureSftRecipe() {
  return {
    schemaVersion: "openpond.sftRecipe.v1",
    method: "sft",
    parameterization: "lora",
    baseModel: {
      id: "openpond/tiny-cpu-gpt2-fixture",
      revision: "architecture-v2-seed-17-context-512",
      tokenizerRevision: "wordlevel-v1",
      chatTemplateHash: "fixture00000000",
    },
    dataset: {
      trainSplit: "train",
      validationSplit: "frozen_eval",
      completionOnly: true,
      maxSequenceLength: 512,
    },
    lora: {
      rank: 2,
      alpha: 4,
      dropout: 0,
      targetModules: ["c_attn"],
    },
    optimizer: {
      learningRate: 0.01,
      epochs: 1,
      maxSteps: 2,
      batchSize: 1,
      gradientAccumulationSteps: 1,
      seed: 17,
    },
    resourceLimits: {
      cpuThreads: 2,
      memoryBytes: 2_000_000_000,
      wallTimeMs: 120_000,
    },
  };
}
