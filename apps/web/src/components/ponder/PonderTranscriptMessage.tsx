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

export function PonderTranscriptOutputs({message,work,onOpenOutput,onOpenLocalOutput}: {
  message:PonderConversationMessage;work:readonly PonderLinkedWork[];
  onOpenOutput(fileId:string):void;
  onOpenLocalOutput(source:PonderLocalMessagePresentation,outputId:string):void;
}) {
  const parsed=PonderLocalMessagePresentationSchema.safeParse(message.metadata.ponderLocalMessage);
  const local=parsed.success?parsed.data:null;
  return <div className="ponder-message-destination">
    {message.metadata.ponderMessage?.outputFileIds.map(fileId=><button key={fileId} type="button" onClick={()=>onOpenOutput(fileId)}>
      {work.flatMap(task=>task.deliveries.flatMap(delivery=>delivery.outputs)).find(output=>output.id===fileId)?.title ?? "Saved file"}
    </button>)}
    {local?.outputs.map(output=><button key={output.id} type="button" onClick={()=>onOpenLocalOutput(local,output.id)}>{output.title} · Download</button>)}
  </div>;
}
