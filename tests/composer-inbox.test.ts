import { expect, it } from "vitest";
import type { RuntimeEvent, TaskInput, TaskInboxSnapshot } from "@openpond/contracts";
import { composerInboxEntries } from "../apps/web/src/lib/composer-inbox";

// Receipts are repeated as delivery advances; stale events must never resurrect pending messages or leak another chat's history.
it("merges incoming, outgoing and Ponder receipts without stale or cross-chat entries", () => {
  const input: TaskInput = { id:"message",sequence:1,sessionId:"here",senderSessionId:"peer",senderKind:"task",kind:"message",body:"Update",payload:{},idempotencyKey:"key",replyTo:null,expectedTurnId:null,turnId:null,requestIds:[],state:"pending",revision:1,createdAt:"2026-10-15T12:00:00Z",updatedAt:"2026-10-15T12:00:00Z",error:null };
  const event = (receipt: TaskInput, sessionId = "here", direction = "received") => ({ name:"task.input", sessionId, data:{input:receipt,delivery:{direction,peer:{sessionId:direction === "sent" ? receipt.sessionId : receipt.senderSessionId,title:"Peer chat"}}} }) as RuntimeEvent;
  const snapshot = {sessionId:"here",inputs:[{...input,state:"resolved",revision:3},{...input,id:"ponder",senderSessionId:null,senderKind:"ponder"}],waits:[],activeTurnId:null,acceptingInput:false,paused:false} as TaskInboxSnapshot;
  const rows = composerInboxEntries("here",snapshot,[event({...input,state:"included",revision:2}),event(input),event({...input,id:"outgoing",sessionId:"peer",senderSessionId:"here"},"here","sent"),event({...input,id:"foreign"},"elsewhere")]);
  expect(rows).toHaveLength(3);
  expect(rows.find(row=>row.input.id==="message")).toMatchObject({peer:"Peer chat",input:{revision:3,state:"resolved"}});
  expect(rows.find(row=>row.input.id==="ponder")).toMatchObject({peer:"Ponder Pal",direction:"received"});
  expect(rows.find(row=>row.input.id==="outgoing")).toMatchObject({peer:"Peer chat",direction:"sent"});
});
