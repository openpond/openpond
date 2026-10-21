import { useCallback, useRef, useState } from "react";
import type { NativeAgentQuestion } from "@openpond/agent-runtime";
import type { Approval, ResolveApprovalRequest } from "@openpond/contracts";
import type { ClientConnection } from "../../api";
import type { ShowAppToast } from "../../app/app-state";
import { requestVoiceInputSubmit } from "../../lib/voice-transcription-job";
import { ArrowUp } from "../icons";
import { NativeQuestionFields } from "./NativeQuestionFields";

type Props = {
  approval: Approval;
  questions: NativeAgentQuestion[];
  canAccept: boolean;
  canSkip: boolean;
  connection: ClientConnection | null;
  showToast: ShowAppToast;
  onResolve(id: string, decision: ResolveApprovalRequest["decision"], answers?: Record<string, string>): Promise<void>;
};

export function NativeQuestionRequest({ approval, questions, canAccept, canSkip, connection, showToast, onResolve }: Props) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [voiceChannel, setVoiceChannel] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const handleVoiceActiveChange = useCallback((channel: string, active: boolean) => {
    setVoiceChannel(current => active ? channel : current === channel ? null : current);
  }, []);
  const complete = (values: Record<string, string>) => questions.every(question => values[question.question]?.trim());

  async function resolve(decision: "accept" | "decline", values = answers) {
    if (pendingRef.current || (decision === "accept" && (!canAccept || !complete(values))) || (decision === "decline" && !canSkip)) return;
    pendingRef.current = true;
    setPending(true);
    try {
      await onResolve(approval.id, decision, decision === "accept" ? values : undefined);
    } catch {
      // The caller reports request failures through the app toast system.
      pendingRef.current = false;
      setPending(false);
    }
  }

  return (
    <section className="native-question-request" data-notification-approval={approval.id} aria-label="Questions from agent" aria-busy={pending}>
      <div className="native-question-body">
        <NativeQuestionFields
          questions={questions} answers={answers} disabled={pending}
          connection={connection} showToast={showToast}
          onChange={setAnswers} onSubmit={values => void resolve("accept", values)}
          activeVoiceChannel={voiceChannel} onVoiceActiveChange={handleVoiceActiveChange}
        />
      </div>
      <div className="native-question-actions">
        <button type="button" className="native-question-skip" disabled={pending || !canSkip} onClick={() => void resolve("decline")}>Skip</button>
        <button type="button" className="native-question-send" disabled={pending || !canAccept || (!voiceChannel && !complete(answers))}
          onClick={() => {
            if (voiceChannel && requestVoiceInputSubmit(voiceChannel)) return;
            void resolve("accept");
          }}>
          <ArrowUp size={14} /><span>{pending ? "Sending" : "Send"}</span>
        </button>
      </div>
    </section>
  );
}
