import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { ChatNextStepSchema, type ChatNextStep, type RuntimeEvent } from "@openpond/contracts";
import type { ClientConnection } from "../../api/api-client";
import { connectionQueryScope } from "../../lib/query-scope";
import { chatResourceRequest } from "../../api/chat-resource-api";
import { addResourceRequestToChat } from "./composer-resource-request";
import type { ComposerInlineInputHandle } from "./ComposerInlineInput";

export function useComposerNextStep({ connection, sessionId, events, blocked, prompt, selectionKey, inputRef }: {
  connection: ClientConnection | null; sessionId: string | null; events: readonly RuntimeEvent[];
  blocked: boolean; prompt: string; selectionKey: string; inputRef: RefObject<ComposerInlineInputHandle | null>;
}) {
  const [value, setValue] = useState<{key:string;suggestion:ChatNextStep} | null>(null);
  const [error, setError] = useState<string | null>(null);
  const composing = useRef(false);
  const accepting = useRef(false), generation = useRef(0);
  const hidden = useRef(new Set<string>());
  const key = `${connectionQueryScope(connection)}:${sessionId}:${selectionKey}`;
  const latest = useRef({key,blocked,prompt}); latest.current={key,blocked,prompt};
  const turnRevision = [...events].reverse().find(event=>event.sessionId===sessionId && ["turn.started","turn.completed","turn.failed","turn.interrupted","workspace_action_result"].includes(event.name))?.id;
  useEffect(() => {
    const epoch=++generation.current;
    setValue(null); setError(null);
    if (!connection || !sessionId || blocked || prompt) return;
    const controller=new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function read() {
      try {
        const result=await chatResourceRequest<{suggestion:unknown}>(connection!,"dataset",{action:"next_step",payload:{sessionId,operation:"read"}},controller.signal);
        if (epoch!==generation.current || controller.signal.aborted) return;
        const suggestion=result.suggestion ? ChatNextStepSchema.parse(result.suggestion) : null;
        if (suggestion?.sessionId!==sessionId || !suggestion || hidden.current.has(suggestion.id)) setValue(null);
        else setValue({key,suggestion});
      } catch { /* Suggestions are optional; connection outages use the shell toast. */ }
      finally { if (!controller.signal.aborted) timer=setTimeout(read,10000); }
    }
    void read();
    return ()=>{controller.abort();clearTimeout(timer);};
  },[connection,sessionId,key,blocked,Boolean(prompt),turnRevision]);
  const suggestion=!blocked && !prompt && value?.key===key && !hidden.current.has(value.suggestion.id) ? value.suggestion : null;
  async function accept() {
    if (!connection || !sessionId || !suggestion || composing.current || accepting.current || latest.current.blocked || inputRef.current?.getPrompt()) return;
    const captured=suggestion, capturedKey=key, epoch=generation.current;
    accepting.current=true; setError(null);
    try {
      const response=await chatResourceRequest<{suggestion:unknown}>(connection,"dataset",{action:"next_step",payload:{sessionId,operation:"accept",id:captured.id}});
      hidden.current.add(captured.id); setValue(null);
      if (!response.suggestion || generation.current!==epoch || latest.current.key!==capturedKey || latest.current.blocked || composing.current || inputRef.current?.getPrompt()) return;
      const accepted=ChatNextStepSchema.parse(response.suggestion);
      if (accepted.id!==captured.id || accepted.sessionId!==sessionId) return;
      addResourceRequestToChat({sessionId,text:accepted.draft,contexts:accepted.contexts});
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not prepare this suggestion."); }
    finally { accepting.current=false; }
  }
  function dismiss() {
    if (!suggestion || !connection || !sessionId) return;
    hidden.current.add(suggestion.id);setValue(null);
    void chatResourceRequest(connection,"dataset",{action:"next_step",payload:{sessionId,operation:"dismiss",id:suggestion.id}})
      .catch(cause=>setError(cause instanceof Error ? cause.message : "Could not dismiss this suggestion."));
  }
  function onKeyDown(event: KeyboardEvent) {
    if (composing.current || event.nativeEvent.isComposing || event.keyCode===229) return true;
    if ((event.key==="Enter" || event.key==="Tab") && (accepting.current || event.repeat)) {event.preventDefault();return true;}
    if (!suggestion) return false;
    if (event.key==="Escape") {event.preventDefault();dismiss();return true;}
    if ((event.key==="Enter" || event.key==="Tab") && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();event.stopPropagation();void accept();return true;
    }
    if (event.key.length===1 && !event.ctrlKey && !event.metaKey && !event.altKey) dismiss();
    return false;
  }
  return {suggestion,accept,dismiss,onKeyDown,error, onCompositionStart:()=>{composing.current=true;}, onCompositionEnd:()=>{composing.current=false;}};
}
