import type { RuntimeEvent, Session } from "@openpond/contracts";
import { apiFetch } from "./connection.js";
import type { TerminalSessionConnection } from "./session-state.js";

export const TERMINAL_SELECT_PROJECT_MESSAGE = "Select a project to use this.";

export type TerminalDirectCommandResponse = {
  session: Session;
  events: RuntimeEvent[];
  result: unknown;
};

function isTerminalDirectCommandSession(session: Session | null | undefined): session is Session {
  if (!session || session.provider === "codex") return false;
  if (session.workspaceKind === "local_project") return Boolean(session.cwd?.trim());
  if (
    session.workspaceKind === "sandbox" ||
    session.workspaceKind === "sandbox_template" ||
    session.workspaceKind === "sandbox_app"
  ) {
    return Boolean(session.workspaceId);
  }
  return false;
}

export function terminalDirectCommandBlockedReason(session: Session | null | undefined): string | null {
  return isTerminalDirectCommandSession(session) ? null : TERMINAL_SELECT_PROJECT_MESSAGE;
}

export async function runTerminalDirectCommand(
  connection: TerminalSessionConnection,
  session: Session,
  command: string,
): Promise<TerminalDirectCommandResponse> {
  return apiFetch<TerminalDirectCommandResponse>(
    connection.server,
    connection.token,
    `/v1/sessions/${encodeURIComponent(session.id)}/commands`,
    {
      method: "POST",
      body: JSON.stringify({
        command,
        cwd: session.cwd,
      }),
    },
  );
}
