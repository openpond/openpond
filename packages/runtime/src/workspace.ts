import { selectOpenPondAccountWorkspace } from "@openpond/cloud";
import type {
  OpenPondAccountWorkspaceSelection,
  OpenPondAccountWorkspaceSelectionResponse,
} from "@openpond/cloud";
import { loadOpenPondAccountContext } from "./account-context.js";

export async function selectOpenPondWorkspace(
  input: OpenPondAccountWorkspaceSelection
): Promise<OpenPondAccountWorkspaceSelectionResponse> {
  const context = await loadOpenPondAccountContext();
  if (!context.token) {
    throw new Error("An authenticated OpenPond account is required to select a workspace.");
  }
  return selectOpenPondAccountWorkspace(context.apiBaseUrl, context.token, input);
}
