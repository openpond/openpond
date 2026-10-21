import type { Session } from "@openpond/contracts";
import { createBrowserModelToolDefinitions, type BrowserHarnessToolExecutor } from "../../openpond/browser-tool-registry.js";
import { enabledModelToolDefinitions } from "../../openpond/model-tool-registry.js";
import { filterModelToolsForExperience } from "../experience-policy.js";

export const NATIVE_BROWSER_INSTRUCTIONS = [
  "Use openpond_browser_open, openpond_browser_snapshot, openpond_browser_move_cursor, openpond_browser_click, openpond_browser_type, openpond_browser_key, and openpond_browser_scroll to operate the desktop in-app browser for this conversation.",
  "These tools use the app's browser session and existing logins. Open or focus the browser, then take a snapshot and use its target refs for interactions. Cursor movements and clicks are visible in the app.",
  "When the user requests the in-app browser, use these tools. If they are unavailable or fail, report that limitation; do not copy browser cookies or profiles into a separate browser as a workaround.",
].join("\n");

export function nativeBrowserTools(session: Session, executor?: BrowserHarnessToolExecutor) {
  return enabledModelToolDefinitions(
    filterModelToolsForExperience(session, createBrowserModelToolDefinitions(executor)),
    { session, provider: session.provider, model: session.modelRef?.modelId ?? "native", mentionedApps: [] },
  );
}
