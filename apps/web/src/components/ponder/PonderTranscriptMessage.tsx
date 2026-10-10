import type { ClientConnection } from "../../api/api-client";
import type { ReactNode } from "react";
import { MessageFooter, MessageTimestamp } from "../chat/MessageFooter";
import { MessageRow } from "../chat/Messages";
import type { PonderLinkedWork } from "./PonderResultAttention";
import {
  PonderLocalMessagePresentationSchema,
  type PonderLocalMessagePresentation,
} from "@openpond/contracts";

type Presentation = {
  version: 1;
  direction: "sent" | "received";
  conversationId: string;
  title: string;
  turnId: string;
  receiptId: string;
  status: "queued" | "consumed" | "completed" | "failed" | "cancelled";
  body: string;
  outputFileIds: string[];
};
export type PonderConversationMessage = {
  id: string;
  role: string;
  text: string;
  createdAt: string;
  source: string | null;
  metadata: { ponderMessage?: Presentation; ponderLocalMessage?: unknown; kvCacheSummary?: { cacheHitRate: number | null } };
};

export function PonderTranscriptMessage({
  message,
  connection,
  work,
  onOpenWork,
  onOpenOutput,
  onOpenLocalWork,
  onOpenLocalOutput,
  agentSources,
}: {
  message: PonderConversationMessage;
  connection: ClientConnection;
  work: readonly PonderLinkedWork[];
  onOpenWork: (conversationId: string) => void;
  onOpenOutput: (fileId: string) => void;
  onOpenLocalWork: (source: PonderLocalMessagePresentation) => void;
  onOpenLocalOutput: (
    source: PonderLocalMessagePresentation,
    outputId: string,
  ) => void;
  agentSources?: ReactNode;
}) {
  if (message.source === "ponder-recommendation") return null;
  const presentation = message.metadata.ponderMessage;
  const parsedLocal = PonderLocalMessagePresentationSchema.safeParse(
    message.metadata.ponderLocalMessage,
  );
  const local = parsedLocal.success ? parsedLocal.data : null;
  if (
    !presentation &&
    !local &&
    message.role !== "user" &&
    message.role !== "assistant"
  )
    return null;
  const content = local?.body ?? presentation?.body ?? message.text;
  if (!presentation && !local && message.role === "assistant" && !content.trim())
    return null;
  return (
    <div className={`ponder-transcript-message ${local || presentation ? "task-handoff" : ""}`}
      data-chat-user-message={message.role === "user" && !local && !presentation ? "true" : undefined}>
      <MessageRow
        showFooter={false}
        connection={connection}
        conversationLinks={work}
        onOpenSession={onOpenWork}
        message={{
          id: message.id,
          role: local || presentation || message.role === "user" ? "user" : "assistant",
          content,
          timestamp: message.createdAt,
        }}
      />
      {local ? (
        <div className="ponder-message-destination">
          <MessageTimestamp timestamp={message.createdAt} />
          <span>
            {local.direction === "sent" ? "Sent to" : "Received from"}{" "}
          </span>
          <button type="button" onClick={() => onOpenLocalWork(local)}>
            {local.title}
          </button>
          <span>
            {" "}
            · Local task ·{" "}
            {local.status === "resolved"
              ? "Delivered"
              : local.status === "included"
                ? "Included in agent request"
                : local.status.replaceAll("_", " ")}
          </span>
        </div>
      ) : null}
      {presentation ? (
        <div className="ponder-message-destination">
          <MessageTimestamp timestamp={message.createdAt} />
          <span>
            {presentation.direction === "sent"
              ? "Sent to"
              : "Received from"}{" "}
          </span>
          <button
            type="button"
            onClick={() => onOpenWork(presentation.conversationId)}
          >
            {presentation.title}
          </button>
          <span>
            {" "}
            ·{" "}
            {presentation.status === "consumed"
              ? "Delivered"
              : presentation.status.replaceAll("_", " ")}
          </span>
        </div>
      ) : null}
      {agentSources}
      {!local && !presentation && message.role === "assistant" ? <MessageFooter content={content} timestamp={message.createdAt} kvCacheSummary={message.metadata.kvCacheSummary} /> : null}
      {presentation?.outputFileIds.map((fileId) => (
        <button key={fileId} type="button" onClick={() => onOpenOutput(fileId)}>
          {work
            .flatMap((task) =>
              task.deliveries.flatMap((delivery) => delivery.outputs),
            )
            .find((output) => output.id === fileId)?.title ?? "Saved file"}
        </button>
      ))}
      {local?.outputs.map((output) => (
        <button
          key={output.id}
          type="button"
          onClick={() => onOpenLocalOutput(local, output.id)}
        >
          {output.title} · Download
        </button>
      ))}
    </div>
  );
}
