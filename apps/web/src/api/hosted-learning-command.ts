import type { LearningCommand } from "openpond-sdk/learning";
import { ApiRequestError } from "./api-client";

interface CommandClient {
  overview(query: { policyId?: string }): Promise<{ iteration: { id: string; revision: number } | null }>;
  command(command: LearningCommand): Promise<unknown>;
}

// Keep the exact request after an uncertain response. Only a confirmed CAS
// rejection permits a new operation identity and a fresh iteration revision.
export async function executeHostedLearningCommand(client: CommandClient, pending: { current: LearningCommand | null }, requested: LearningCommand, policyId?: string) {
  let command = pending.current ?? requested;
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!pending.current && command.action === "cancel_iteration") {
        const current = await client.overview({ policyId });
        if (current.iteration?.id !== command.iterationId) throw new Error("The selected iteration changed. Refresh before cancelling.");
        command = { ...command, expectedRevision: current.iteration.revision };
      }
      pending.current ??= command;
      try { await client.command(pending.current); pending.current = null; return; }
      catch (failure) {
        if (command.action !== "cancel_iteration" || attempt === 2 || !(failure instanceof ApiRequestError)
          || failure.status !== 409 || !failure.message.startsWith("learning_revision_conflict:")) throw failure;
        pending.current = null;
        command = { ...command, operationId: crypto.randomUUID() };
      }
    }
  } catch (failure) {
    if (failure instanceof ApiRequestError && failure.status >= 400 && failure.status < 500 && ![408, 429].includes(failure.status)) pending.current = null;
    throw failure;
  }
}
