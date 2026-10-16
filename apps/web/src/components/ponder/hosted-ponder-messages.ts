import {PonderLocalMessagePresentationSchema, type PonderLocalMessagePresentation} from "@openpond/contracts";
import type {ChatMessage} from "../../lib/app-models";
import type {PonderConversationMessage} from "./PonderTranscriptMessage";

/** Adapt cloud receipt metadata into the same display model used by local threads. */
export function hostedPonderMessages(transcript: readonly PonderConversationMessage[]) {
  const messages: ChatMessage[] = [];
  const sources = new Map<string, PonderConversationMessage>();
  const localPeers = new Map<string, PonderLocalMessagePresentation>();
  for (const message of transcript) {
    if (message.source === "ponder-recommendation") continue;
    const parsed = PonderLocalMessagePresentationSchema.safeParse(message.metadata.ponderLocalMessage);
    const local = parsed.success ? parsed.data : null;
    const hosted = message.metadata.ponderMessage;
    if (local || hosted) {
      const receipt = local ?? hosted!;
      const peerId = local?.sessionId ?? hosted!.conversationId;
      const state = receipt.status === "resolved" || receipt.status === "completed" ? "resolved"
        : receipt.status === "consumed" || receipt.status === "included" ? "included"
        : receipt.status === "cancelled" ? "cancelled"
        : receipt.status === "failed" || receipt.status === "rejected" ? "rejected" : "pending";
      messages.push({id:message.id,role:"task_message",content:receipt.body,timestamp:message.createdAt,
        taskMessagePresentation:{input:{body:receipt.body,state,error:null},direction:receipt.direction,
          peer:{sessionId:peerId,title:receipt.title,provider:local?"local":"openpond"}}});
      if (local) localPeers.set(peerId,local);
      if (local?.outputs.length || hosted?.outputFileIds.length) {
        const id = `${message.id}:outputs`;
        messages.push({id,role:"resources",timestamp:message.createdAt});
        sources.set(id,message);
      }
    } else if (message.role === "user" || message.role === "assistant" && message.text.trim()) {
      messages.push({id:message.id,role:message.role as "user" | "assistant",content:message.text,
        timestamp:message.createdAt,finalAnswer:message.role === "assistant",footerCacheSummary:message.metadata.kvCacheSummary});
    }
  }
  return {messages,sources,localPeers};
}
