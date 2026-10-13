import {expect,test,vi} from "vitest";
import {readChatHostedTrainingAttachment} from "./chat-hosted-training-attachment.js";

// A hosted ID must be resolved through the pinned account/origin, and even a
// successful remote response cannot substitute a different job or workspace.
test("hosted attachment checks origin and account before reading, then checks canonical job identity",async()=>{
  const access = {apiBaseUrl:"https://api.example.test",token:"test-token",teamId:"team",actorId:"actor"};
  const reference = {jobId:"job",apiOrigin:access.apiBaseUrl,teamId:access.teamId,actorId:access.actorId};
  const job = {schemaVersion:"openpond.trainingJob.v2",id:"job",teamId:"team",kind:"policy_optimize",
    modelProjectId:"hosted-model",portableProjectId:"portable-model",sourceProjectRevision:2,submissionHash:"a".repeat(64),
    state:"running",phase:"training",version:3,progress:0.5,
    rolloutProgress:{groupsCompleted:1,groupsTarget:2,optimizerUpdatesApplied:1,optimizerUpdatesSkipped:0},
    accruedSpendUsd:0.1,terminalReason:null,createdAt:"2026-10-13T00:00:00.000Z",updatedAt:"2026-10-13T00:01:00.000Z",completedAt:null};
  const request = vi.fn<typeof fetch>(async()=>new Response(JSON.stringify({job})));
  await expect(readChatHostedTrainingAttachment(access,{...reference,actorId:"other"},request)).rejects.toThrow("account");
  await expect(readChatHostedTrainingAttachment(access,{...reference,apiOrigin:"https://other.example.test"},request)).rejects.toThrow("origin");
  expect(request).not.toHaveBeenCalled();
  expect(await readChatHostedTrainingAttachment(access,reference,request)).toMatchObject({location:"cloud",jobId:"job",job,owner:{teamId:"team",actorId:"actor"}});
  request.mockResolvedValue(new Response(JSON.stringify({job:{...job,id:"different"}})));
  await expect(readChatHostedTrainingAttachment(access,reference,request)).rejects.toThrow("another job");
});
