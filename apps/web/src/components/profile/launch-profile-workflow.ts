import { validateTaskValue } from "@openpond/evals/task-schema";

import { api, type ClientConnection, type ProfileWorkflowDiscovery } from "../../api";

/** Admit the exact discovered release before sending its validated input. */
export async function launchProfileWorkflow(input: {
  connection: ClientConnection;
  catalog: ProfileWorkflowDiscovery;
  workflowId: string;
  value: unknown;
  client?: Pick<typeof api, "createSession" | "sendTurn">;
}): Promise<string> {
  const selected = input.catalog.workflows.find((entry) => entry.workflow.id === input.workflowId);
  if (!selected) throw new Error("Selected Profile workflow is unavailable.");
  const validated = validateTaskValue(selected.workflow.inputSchema, input.value);
  if (!validated.valid) {
    throw new Error(validated.issues[0]?.message ?? "Workflow input does not match its schema.");
  }
  const client = input.client ?? api;
  const session = await client.createSession(input.connection, {
    experience: "work",
    provider: "openpond",
    currentProfile: input.catalog.profileRef,
    profileWorkflowBinding: selected.binding,
    title: selected.workflow.label,
  });
  await client.sendTurn(input.connection, session.id, {
    prompt: selected.workflow.label,
    workflowInput: input.value,
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    codexPermissionMode: "default",
  });
  return session.id;
}
