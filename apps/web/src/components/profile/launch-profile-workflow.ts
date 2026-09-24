import type { ChatAttachment } from "@openpond/contracts";
import { api, type ClientConnection, type ProfileWorkflowDiscovery } from "../../api";

/** Admit the exact discovered release; the app-server validates workflow input. */
export async function launchProfileWorkflow(input: {
  connection: ClientConnection;
  catalog: ProfileWorkflowDiscovery;
  workflowId: string;
  value: unknown;
  prompt?: string;
  attachments?: ChatAttachment[];
  workspaceTarget?: "local" | "hosted";
  onSessionCreated?: (sessionId: string) => void;
  client?: Pick<typeof api, "createSession" | "sendTurn">;
}): Promise<string> {
  const selected = input.catalog.workflows.find((entry) => entry.workflow.id === input.workflowId);
  if (!selected) throw new Error("Selected Profile workflow is unavailable.");
  const client = input.client ?? api;
  const session = await client.createSession(input.connection, {
    experience: "work",
    provider: "openpond",
    ...(input.workspaceTarget === "local" ? { metadata: { workspaceTarget: "local" } } : {}),
    currentProfile: input.catalog.profileRef,
    profileWorkflowBinding: selected.binding,
    title: selected.workflow.label,
  });
  input.onSessionCreated?.(session.id);
  await client.sendTurn(input.connection, session.id, {
    prompt: input.prompt?.trim() || selected.workflow.label,
    workflowInput: input.value,
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    codexPermissionMode: "default",
  });
  return session.id;
}
