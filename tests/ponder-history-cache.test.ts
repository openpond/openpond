import {expect,test} from "vitest";
import type {RuntimeEvent} from "@openpond/contracts";
import {mergePonderHistoryEvents,ponderHistoryPage} from "../apps/web/src/components/ponder/ponder-history-cache";

// Failure story: returning to a cached chat duplicates replayed text or rewinds
// the reconnect cursor while older pages race with live assistant deltas.
test("cached history merges overlapping pages without rewinding the live replay cursor",()=>{
  const event=(sequence:number,output=String(sequence)):RuntimeEvent=>({id:`event-${sequence}`,sequence,
    sessionId:"ponder",name:"assistant.delta",timestamp:"2026-10-15T20:00:00Z",output});
  const page=ponderHistoryPage({events:[{sequence:20,event:{...event(20),sequence:undefined}}],
    sessionId:"ponder",afterSequence:0,beforeSequence:999,nextSequence:20,previousSequence:20,
    hasMore:true,limit:200,totalMatchingEvents:20,remainingMatchingEvents:20});
  const live=mergePonderHistoryEvents(page,[event(22),event(21)]);
  const replay=mergePonderHistoryEvents(live,[event(20),event(21),event(10)]);
  expect(page.events[0]?.sequence).toBe(20);
  expect(replay.events.map(row=>row.sequence)).toEqual([10,20,21,22]);
  expect(replay.cursor).toBe(22);
  expect(page.events).toHaveLength(1);
  expect(replay.before).toBe(20);
});
