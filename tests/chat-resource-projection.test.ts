import {expect,test} from "vitest";
import type {RuntimeEvent,ChatResourceSummary} from "@openpond/contracts";
import {buildChatMessages} from "../apps/web/src/lib/chat-messages";
import {buildChatTimelineRows,chatTimelineMessages} from "../apps/web/src/lib/chat-timeline-rows";

// Failure story: replayed or late scaffolds must not replace saved rows, and
// completing a response must not duplicate or move its resource into hidden work.
test("persisted resource replay keeps one final response identity and newest saved revision",()=>{
  const summary:ChatResourceSummary={kind:"dataset",id:"dataset-one",revision:1,name:"Examples",state:"Creating",rows:[]};
  const event=(id:string,seconds:number,fields:Partial<RuntimeEvent>):RuntimeEvent=>({id,name:"workspace_action_result",source:"server",sessionId:"chat",turnId:"turn",timestamp:new Date(Date.UTC(2026,9,10,12,0,seconds)).toISOString(),...fields});
  const start=event("start",0,{name:"turn.started",args:{prompt:"Make a dataset"}});
  const scaffold=event("scaffold",1,{data:{chatResource:summary}});
  const saved=event("saved",2,{data:{chatResource:{...summary,state:"Saved draft",rows:[{id:"one",label:"Actual saved row",detail:""}]}}});
  const final=event("answer",3,{name:"assistant.delta",output:"Your dataset is saved."});
  const newer=event("newer",5,{data:{chatResource:{...summary,revision:2,state:"Saved draft",taskCount:2}}});
  const events=[start,scaffold,saved,final,newer,event("late",6,{data:{chatResource:summary}}),event("forged",7,{source:"model",data:{chatResource:{...summary,revision:99}}})];
  const live=buildChatMessages(events),completed=buildChatMessages([...events,event("complete",8,{name:"turn.completed"})]);
  const resource=completed.filter(message=>message.role==="resources");
  expect(resource).toHaveLength(1);expect(resource[0]).toMatchObject({id:"chat-resources:turn",resources:[{id:"dataset-one",revision:2,taskCount:2}]});
  expect(live.find(message=>message.role==="resources")?.id).toBe(resource[0]?.id);
  const rows=buildChatTimelineRows(completed);expect(rows.at(-1)).toMatchObject({type:"message",message:{role:"resources"}});
  expect(chatTimelineMessages(rows).filter(message=>message.role==="resources")).toHaveLength(1);
  // Native MCP completion can report transport completion around a failed
  // domain call. Retain one failed activity and its error, not a successful save.
  const tool={id:"native-call",type:"mcpToolCall",tool:"openpond_dataset",arguments:{action:"create",operationId:"native-author"}};
  const failedMessages=buildChatMessages([start,
    event("native-start",1,{name:"tool.started",action:"mcpToolCall",status:"started",data:{...tool,status:"inProgress"}}),
    event("native-fail",2,{name:"tool.completed",action:"mcpToolCall",status:"completed",data:{...tool,status:"failed",result:{content:[{type:"text",text:"Local storage unavailable"}]},error:{message:"Retained native transport error"}}}),
    event("native-complete",3,{name:"turn.completed"})]);
  const activities=failedMessages.flatMap(message=>message.activities ?? []);
  expect(activities).toHaveLength(1);
  expect(activities[0]).toMatchObject({callId:"native-call",action:"openpond_dataset",state:"failed",detail:expect.stringContaining("Local storage unavailable")});
  expect(activities[0]?.detail).toContain("Retained native transport error");
  expect(failedMessages.some(message=>message.role==="resources")).toBe(false);
});
