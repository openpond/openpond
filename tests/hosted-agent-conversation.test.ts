import { expect, test } from "vitest";
import type { PonderHostedAssignment, PonderHostedAssignmentDetail } from "@openpond/contracts";
import { hostedPonderMessages } from "../apps/web/src/components/ponder/hosted-ponder-messages";
import type { PonderConversationMessage } from "../apps/web/src/components/ponder/PonderTranscriptMessage";
import { hostedAgentMessages } from "../apps/web/src/components/ponder/hosted-agent-messages";
import { buildChatTimelineRows } from "../apps/web/src/lib/chat-timeline-rows";

// Public Work streams can omit or truncate their last delta; the retained receipt
// must restore one final answer without losing interim dialogue or tool history.
test("projects hosted progress through the shared chat timeline with one authoritative final answer", () => {
  const assignment: PonderHostedAssignment = {id:"job",coordinatorId:"coordinator",title:"Worker",assignment:"Inspect the input",state:"completed",
    remoteConversationId:"remote",remoteTurnId:"turn",lastSequence:5,resultText:"Verified answer",wait:null,error:null,
    createdAt:"2026-10-15T12:00:00Z",updatedAt:"2026-10-15T12:01:00Z",canCancel:false,account:{id:"owner",apiBaseUrl:"https://workspace.test",teamId:"team"}};
  const events: PonderHostedAssignmentDetail["events"] = [
    {id:"progress",sequence:1,type:"assistant.delta",text:"I will inspect the file."},
    {id:"start",sequence:2,type:"tool.started",text:"work_read_file: started"},
    {id:"end",sequence:3,type:"tool.completed",text:"work_read_file: completed"},
    {id:"reasoning",sequence:4,type:"assistant.reasoning.delta",text:"The file is valid."},
    {id:"partial",sequence:5,type:"assistant.delta",text:"Verified ans"},
  ];
  for (const stream of [events, events.slice(0,-1)]) {
    const messages=hostedAgentMessages(assignment,stream);
    expect(messages.filter(message=>message.role==="user").map(message=>message.content)).toEqual([assignment.assignment]);
    expect(messages.filter(message=>message.content==="Verified answer")).toHaveLength(1);
    expect(messages.some(message=>message.content==="I will inspect the file.")).toBe(true);
    expect(messages.some(message=>message.reasoningContent==="The file is valid.")).toBe(true);
    expect(messages.find(message=>message.content==="Verified answer")?.finalAnswer).toBe(true);
    expect(buildChatTimelineRows(messages).find(row=>row.type==="work")?.label).toBe("Worked");
    expect(messages.find(message=>message.finalAnswer)?.timestamp).toBe("");
  }
  const cancelled=hostedAgentMessages({...assignment,state:"cancelled",resultText:null},events.slice(0,3));
  expect(cancelled.some(message=>message.statusKind==="interruption")).toBe(true);
  expect(cancelled.some(message=>message.finalAnswer)).toBe(false);
});

// Cloud coordinator receipts are display records, not local TaskInputs. The shared
// thread must retain their bodies, authority scope and outputs without inventing
// local turn ownership or duplicating the assistant response.
test("adapts hosted coordinator exchanges without losing remote or local delivery evidence", () => {
  const base = {createdAt:"2026-10-15T12:00:00Z",source:null,role:"assistant",text:"Transport wrapper"};
  const local = {version:1 as const,direction:"received" as const,operationId:"operation",installationId:"11111111-1111-4111-8111-111111111111",
    profileId:"profile",ownerUserId:"owner",teamId:"team",sessionId:"local-worker",title:"Local worker",turnId:"worker-turn",
    receiptId:"local-receipt",status:"resolved",body:"Local result",outputs:[]};
  const hosted = {version:1 as const,direction:"sent" as const,conversationId:"remote-worker",title:"Remote worker",turnId:"remote-turn",
    receiptId:"cloud-receipt",status:"completed" as const,body:"Original assignment",outputFileIds:["result-file"]};
  const transcript: PonderConversationMessage[] = [
    {...base,id:"user",role:"user",text:"Coordinate this",metadata:{}},
    {...base,id:"cloud",metadata:{ponderMessage:hosted}},
    {...base,id:"local",metadata:{ponderLocalMessage:local}},
    {...base,id:"answer",text:"Verified result",metadata:{kvCacheSummary:{cacheHitRate:0.75}}},
    {...base,id:"recommendation",source:"ponder-recommendation",metadata:{}},
  ];
  const result = hostedPonderMessages(transcript);
  expect(result.messages.map(message=>[message.id,message.role,message.content])).toEqual([
    ["user","user","Coordinate this"], ["cloud","task_message","Original assignment"],
    ["cloud:outputs","resources",undefined], ["local","task_message","Local result"], ["answer","assistant","Verified result"],
  ]);
  const exchanges=result.messages.filter(message=>message.role==="task_message");
  expect(exchanges.map(message=>message.taskMessagePresentation)).toEqual([
    {direction:"sent",input:{body:hosted.body,state:"resolved",error:null},peer:{sessionId:hosted.conversationId,title:hosted.title,provider:"openpond"}},
    {direction:"received",input:{body:local.body,state:"resolved",error:null},peer:{sessionId:local.sessionId,title:local.title,provider:"local"}},
  ]);
  expect(exchanges.every(message=>!message.turnId && !message.taskMessage)).toBe(true);
  expect(result.localPeers.get("local-worker")).toEqual(local);
  expect(result.sources.get("cloud:outputs")).toBe(transcript[1]);
  expect(result.messages.at(-1)?.footerCacheSummary).toEqual({cacheHitRate:0.75});
  const rows=buildChatTimelineRows(result.messages);
  expect(rows.filter(row=>row.type==="work").flatMap(row=>row.messages).map(row=>row.message.id)).toEqual(["cloud","local"]);
  expect(rows.filter(row=>row.type==="message").map(row=>row.message.id)).toEqual(["user","answer","cloud:outputs"]);
});
