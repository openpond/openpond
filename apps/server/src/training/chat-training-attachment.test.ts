import { expect, test, vi } from "vitest";
import { ModelRunSchema, TrainingJobSchema } from "@openpond/contracts";
import { readChatTrainingAttachment } from "./chat-training-attachment.js";

// A saved chat reference must never reveal another account's training output,
// or turn an evaluation ID into a training attachment.
test("training attachment resolves canonical records only after checking the admission owner", async () => {
  const owner = {teamId:"team",actorId:"actor"};
  const now = "2026-10-13T00:00:00.000Z";
  const run = ModelRunSchema.parse({schemaVersion:"openpond.modelRun.v1",id:"run",modelId:"model",modelVersionId:null,
    profileId:"profile",kind:"training",status:"running",method:"sft",destinationId:"openpond_managed",
    taskset:{id:"release",revision:3,contentHash:"a".repeat(64)},quote:{maximumSpendUsd:1,hourlyCostUsd:null},reward:null,receipt:null,
    adapterArtifactLineageId:null,failure:null,startedAt:now,completedAt:null,updatedAt:now});
  const job = TrainingJobSchema.parse({schemaVersion:"openpond.trainingJob.v1",id:"job",planId:"plan",bundleHash:"b".repeat(64),
    approvalId:"approval",destinationId:"openpond_managed",status:"running",nonProduction:false,workerPid:null,
    startedAt:now,completedAt:null,error:null,createdAt:now,updatedAt:now,
    metadata:{modelRunId:run.id,activityAuthority:{schemaVersion:"openpond.trainingActivityAuthority.v1",...owner,projectId:null}}});
  const store = {getTrainingJob:vi.fn(async()=>job),listTrainingJobs:vi.fn(async()=>[job]),getModelRun:vi.fn(async()=>run)};
  await expect(readChatTrainingAttachment(store,{jobId:"job"},{...owner,actorId:"other"})).rejects.toThrow("unavailable");
  expect(store.getModelRun).not.toHaveBeenCalled();
  const attachment = await readChatTrainingAttachment(store,{modelRunId:"run"},owner);
  expect(attachment).toMatchObject({jobId:"job",modelRunId:"run",modelId:"model",taskset:run.taskset,owner});
  expect(attachment).not.toHaveProperty("score");
  await expect(readChatTrainingAttachment(store,{jobId:"job",modelRunId:"other"},owner)).rejects.toThrow("matching canonical");
  store.getModelRun.mockResolvedValue({...run,kind:"evaluation"});
  await expect(readChatTrainingAttachment(store,{jobId:"job"},owner)).rejects.toThrow("matching canonical");
});
