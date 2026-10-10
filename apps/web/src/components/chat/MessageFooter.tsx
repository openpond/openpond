import type { UsageTurnCacheSummary } from "@openpond/contracts";
import { Copy } from "../icons";
import { formatMessageTimestamp, formatMessageTimestampTitle } from "../../lib/chat-messages";
import { copyToClipboard } from "../../lib/clipboard";

export function MessageFooter({ content, timestamp, kvCacheSummary }: {
  content?: string;
  timestamp: string;
  kvCacheSummary?: Pick<UsageTurnCacheSummary, "cacheHitRate"> | null;
}) {
  const time = formatMessageTimestamp(timestamp);
  const rate = kvCacheSummary?.cacheHitRate;
  const cachePercent = typeof rate === "number" && Number.isFinite(rate) && rate >= 0 && rate <= 1
    ? Math.round(rate * 100) : 0;
  const cache = cachePercent > 0 ? `${cachePercent}%` : null;
  return <div className="assistant-message-footer">
    {time ? <time className="message-timestamp" dateTime={timestamp}
      title={formatMessageTimestampTitle(timestamp)}>{time}</time> : null}
    {cache ? <span className="message-kv-cache-metric" aria-label={`KV cache reuse ${cache}`}>
      KV {cache}
    </span> : null}
    <button type="button" className="message-copy-button" title="Copy message"
      aria-label="Copy assistant message" disabled={!content}
      onClick={() => { if (content) void copyToClipboard(content); }}>
      <Copy size={14} />
    </button>
  </div>;
}
