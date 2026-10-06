import type { Session } from "@openpond/contracts";
import { Bot, MessageSquare, Terminal } from "../icons";
import { OPENPOND_ICON_URL } from "../../lib/public-assets";

const SOURCES: Record<string, string> = {
  codex: "Codex", "claude-code": "Claude Code", opencode: "OpenCode", "grok-build": "Grok Build",
};

/** Source identity stays visible independently of execution status and expansion. */
export function ConversationSourceIcon({ session }: { session: Session }) {
  const source = SOURCES[session.provider];
  const label = source ?? (session.provider === "openpond" ? "OpenPond" : session.provider);
  return <span className="conversation-source-icon" role="img" aria-label={label} title={label}>
    {source ? <img src={`/agent-sources/${session.provider}.svg`} alt="" />
      : session.provider === "openpond" ? <img src={OPENPOND_ICON_URL} alt="" />
      : session.metadata?.nativeSource ? <Terminal size={15} aria-hidden="true" />
      : session.provider === "openai" ? <Bot size={15} aria-hidden="true" />
      : <MessageSquare size={15} aria-hidden="true" />}
  </span>;
}
