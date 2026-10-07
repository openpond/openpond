import type { UsageTurnCacheSummary } from "@openpond/contracts";
import { Copy } from "../icons";
import { formatMessageTimestamp, formatMessageTimestampTitle } from "../../lib/chat-messages";
import { copyToClipboard } from "../../lib/clipboard";

export function MessageFooter({ content, timestamp, kvCacheSummary }: {
  content?: string;
  timestamp: string;
  kvCacheSummary?: UsageTurnCacheSummary | null;
}) {
  const time = formatMessageTimestamp(timestamp);
  const rate = kvCacheSummary?.cacheHitRate;
  const cache = typeof rate === "number" && Number.isFinite(rate)
    ? `${Math.round(Math.max(0, Math.min(1, rate)) * 100)}%` : "unavailable";
  return <div className="assistant-message-footer">
    {time ? <time className="message-timestamp" dateTime={timestamp}
      title={formatMessageTimestampTitle(timestamp)}>{time}</time> : null}
    {kvCacheSummary ? <span className="message-kv-cache-metric" aria-label={`KV cache reuse ${cache}`}>
      KV {cache}
    </span> : null}
    <button type="button" className="message-copy-button" title="Copy message"
      aria-label="Copy assistant message" disabled={!content}
      onClick={() => { if (content) void copyToClipboard(content); }}>
      <Copy size={14} />
    </button>
  </div>;
}
