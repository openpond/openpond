import { type ComponentProps } from "react";
import { RightSidebarOverview } from "../app-shell/RightSidebarOverview";
import { ChatExperimentTool } from "./ChatExperimentTool";
import "./dataset-workspace.css";

/** One experiment tool works both before the first message and inside a saved chat. */
export function ChatDatasetSidebar(props: ComponentProps<typeof RightSidebarOverview>) {
  if (!props.connection) return <p>Connect to OpenPond to browse experiments.</p>;
  return <ChatExperimentTool connection={props.connection} sessionId={props.sessionId ?? null} events={props.events} />;
}
