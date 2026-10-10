import { ChatResourceSummarySchema, type RuntimeEvent, type ChatResourceSummary } from "@openpond/contracts";
import type { ChatMessage } from "./app-models";
import {asRecord,stringValue} from "./chat-message-utils";

/** Native Codex exposes these calls as MCP items; use their tool envelope for
 * domain activity without treating returned model text as a resource snapshot. */
export function chatResourceToolEvent(event:RuntimeEvent):RuntimeEvent {
  if(event.action!=="mcpToolCall" || !["tool.started","tool.completed"].includes(event.name))return event;
  const data=asRecord(event.data),tool=stringValue(data,["tool"]);
  if(tool!=="openpond_dataset" && tool!=="openpond_experiment")return event;
  return {...event,action:tool,args:asRecord(data?.arguments) ?? undefined,
    status:event.name==="tool.completed" && data?.status==="failed" ? "failed" : event.status};
}

export function chatResourceToolDetail(event:RuntimeEvent):string|null {
  if(event.action!=="openpond_dataset" && event.action!=="openpond_experiment")return null;
  if(event.name==="tool.started")return event.args ? JSON.stringify(event.args,null,2) : null;
  const data=asRecord(event.data),result=asRecord(data?.result);
  const content=Array.isArray(result?.content) ? result.content.flatMap(value=>{
    const block=asRecord(value);
    return block?.type==="text" && typeof block.text==="string" ? [block.text] : [];
  }) : [];
  const error=stringValue(asRecord(data?.error),["message"]);
  if(error)content.push(error);
  return content.length ? content.join("\n") : null;
}

/** One stable response-bottom area per turn. Only persisted server snapshots
 * populate it; model text and tool arguments never become saved rows. */
export function attachChatResources(messages:ChatMessage[],events:RuntimeEvent[]):ChatMessage[] {
  const turns = new Map<string,{sessionId:string;timestamp:string;resources:Map<string,{summary:ChatResourceSummary;timestamp:string}>}>();
  for (const event of events) {
    if (event.source !== "server" || !event.sessionId || !event.turnId || !event.data || typeof event.data !== "object") continue;
    const parsed = ChatResourceSummarySchema.safeParse((event.data as Record<string,unknown>).chatResource);
    if (!parsed.success) continue;
    const summary = parsed.data;
    const turn = turns.get(event.turnId) ?? {sessionId:event.sessionId,timestamp:event.timestamp,resources:new Map()};
    const key = `${summary.kind}:${summary.id}`, previous = turn.resources.get(key);
    if (previous && (summary.revision < previous.summary.revision || summary.revision === previous.summary.revision && (event.timestamp < previous.timestamp || ["Creating","Importing"].includes(summary.state) && !["Creating","Importing"].includes(previous.summary.state)))) continue;
    turn.resources.set(key,{summary,timestamp:event.timestamp}); turns.set(event.turnId,turn);
  }
  const output:ChatMessage[] = [];
  const lastIndexes = new Map<string,number>();
  messages.forEach((message,index)=>{if (message.turnId) lastIndexes.set(message.turnId,index);});
  messages.forEach((message,index)=> {
    output.push(message);
    const turn = message.turnId ? turns.get(message.turnId) : undefined;
    if (turn && lastIndexes.get(message.turnId!) === index) {
      output.push({id:`chat-resources:${message.turnId}`,role:"resources",turnId:message.turnId,resourceSessionId:turn.sessionId,timestamp:turn.timestamp,resources:[...turn.resources.values()].map(r=>r.summary)});
      turns.delete(message.turnId!);
    }
  });
  for (const [turnId,turn] of turns) output.push({id:`chat-resources:${turnId}`,role:"resources",turnId,resourceSessionId:turn.sessionId,timestamp:turn.timestamp,resources:[...turn.resources.values()].map(r=>r.summary)});
  return output;
}
