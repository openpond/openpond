import type { ChatProvider } from "@openpond/contracts";
import type {
  CollectorStatus,
  NativeSource,
} from "@openpond/evals/native-conversations";
import { OPENPOND_ICON_URL } from "../../lib/public-assets";

export type AgentInventory = {
  sources: NativeSource[];
  collector: CollectorStatus;
  directory: string;
  statusCommand: string;
};
export type AgentSource = {
  id: NativeSource["source"] | "openpond_chat";
  name: string;
  icon: string;
  provider?: ChatProvider;
};
export const AGENT_SOURCES: AgentSource[] = [
  { id: "openpond_chat", name: "Ponder Pal", icon: OPENPOND_ICON_URL },
  {
    id: "codex",
    name: "Codex",
    icon: "/agent-sources/codex.svg",
    provider: "codex",
  },
  {
    id: "claude_code",
    name: "Claude Code",
    icon: "/agent-sources/claude-code.svg",
    provider: "claude-code",
  },
  {
    id: "opencode",
    name: "OpenCode",
    icon: "/agent-sources/opencode.svg",
    provider: "opencode",
  },
  {
    id: "grok_build",
    name: "Grok Build",
    icon: "/agent-sources/grok-build.svg",
    provider: "grok-build",
  },
  { id: "hermes", name: "Hermes", icon: "/agent-sources/hermes.png" },
  { id: "pi", name: "Pi", icon: "/agent-sources/pi.svg" },
  { id: "openclaw", name: "OpenClaw", icon: "/agent-sources/openclaw.svg" },
  { id: "oh_my_pi", name: "Oh My Pi", icon: "/agent-sources/oh-my-pi.svg" },
];

export function collectionState(
  connection: CollectorStatus["connections"][number],
  status: CollectorStatus,
) {
  if (connection.state === "disconnected") return "Disconnected";
  if (connection.state === "paused") return "Paused";
  if (connection.error) return "Needs attention";
  if (!status.running)
    return status.desiredState === "stopped"
      ? "Importer stopped"
      : "Importer offline";
  if (connection.backfill.stage !== "complete") return "Importing history";
  return connection.queued ? "Uploading updates" : "Watching for conversations";
}
