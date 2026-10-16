import type { RuntimeEvent } from "@openpond/contracts";
import type { RuntimeEventPagePayload } from "../../api";

export type PonderHistorySnapshot = {events:RuntimeEvent[];cursor:number;before:number;hasMore:boolean};

/** History pages and replayed stream events may overlap; the replay cursor never regresses. */
export function mergePonderHistoryEvents(snapshot:PonderHistorySnapshot,incoming:RuntimeEvent[]):PonderHistorySnapshot {
  const byId=new Map(snapshot.events.map(event=>[event.id,event]));
  for(const event of incoming)byId.set(event.id,event);
  const events=[...byId.values()].sort((a,b)=>(a.sequence??0)-(b.sequence??0));
  return {...snapshot,events,cursor:Math.max(snapshot.cursor,...incoming.map(event=>event.sequence??0))};
}

export function ponderHistoryPage(page:RuntimeEventPagePayload):PonderHistorySnapshot {
  return {events:page.events.map(row=>({...row.event,sequence:row.sequence})),cursor:page.nextSequence,
    before:page.previousSequence,hasMore:page.hasMore};
}
