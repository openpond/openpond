import type { UsageTurnCacheSummary } from "@openpond/contracts";
import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "../icons";
import { useErrorToast } from "../../app/AppToastContext";
import { formatMessageTimestamp, formatMessageTimestampTitle } from "../../lib/chat-messages";
import { copyToClipboard } from "../../lib/clipboard";

export function MessageFooter({ content, timestamp, kvCacheSummary }: {
  content?: string;
  timestamp: string;
  kvCacheSummary?: Pick<UsageTurnCacheSummary, "cacheHitRate"> | null;
}) {
  const footerRef = useRef<HTMLDivElement>(null);
  const copyRevision = useRef(0);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<unknown>(null);
  useErrorToast(copyError);

  useEffect(() => {
    const message = footerRef.current?.closest(".message-row, .ponder-transcript-message");
    const reset = () => { copyRevision.current++; setCopied(false); };
    const onFocusOut = (event: Event) => {
      if (!message?.contains((event as FocusEvent).relatedTarget as Node | null)) reset();
    };
    reset();
    message?.addEventListener("pointerleave", reset);
    message?.addEventListener("focusout", onFocusOut);
    window.addEventListener("scroll", reset, true);
    return () => {
      copyRevision.current++;
      message?.removeEventListener("pointerleave", reset);
      message?.removeEventListener("focusout", onFocusOut);
      window.removeEventListener("scroll", reset, true);
    };
  }, [content]);

  async function copyMessage() {
    if (!content) return;
    const revision = ++copyRevision.current;
    setCopyError(null);
    const success = await copyToClipboard(content);
    if (revision !== copyRevision.current) return;
    setCopied(success);
    if (!success) setCopyError(new Error("Could not copy the message. Try again."));
  }

  const rate = kvCacheSummary?.cacheHitRate;
  const cachePercent = typeof rate === "number" && Number.isFinite(rate) && rate >= 0 && rate <= 1
    ? Math.round(rate * 100) : 0;
  const cache = cachePercent > 0 ? `${cachePercent}%` : null;
  return <div className="assistant-message-footer" ref={footerRef}>
    <MessageTimestamp timestamp={timestamp} />
    {cache ? <span className="message-kv-cache-metric" aria-label={`KV cache reuse ${cache}`}>
      KV {cache}
    </span> : null}
    <button type="button" className={`message-copy-button${copied ? " is-copied" : ""}`} title={copied ? "Copied" : "Copy message"}
      aria-label={copied ? "Message copied" : "Copy assistant message"} disabled={!content}
      onClick={() => void copyMessage()}>
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  </div>;
}

export function MessageTimestamp({ timestamp }: { timestamp: string }) {
  const time = formatMessageTimestamp(timestamp);
  return time ? <time className="message-timestamp" dateTime={timestamp}
    title={formatMessageTimestampTitle(timestamp)}>{time}</time> : null;
}
