import { type ComponentProps } from "react";
import { RightSidebarOverview } from "../app-shell/RightSidebarOverview";
import { ChatExperimentTool } from "./ChatExperimentTool";
import "./dataset-workspace.css";

/** One experiment tool works both before the first message and inside a saved chat. */
export function ChatDatasetSidebar(props: ComponentProps<typeof RightSidebarOverview>) {
  if (!props.connection) return <p>Open the local server connection to browse Benchmarks.</p>;
  return <ChatExperimentTool connection={props.connection} sessionId={props.sessionId ?? null} events={props.events} />;
}
