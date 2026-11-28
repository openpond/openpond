import { z } from "zod";
import { LocalExperimentError } from "./local-experiment-contract.js";
import type { createChatExperiments } from "./chat-experiments.js";

const lookup = z.object({ id: z.string().trim().min(1).max(240) }).strict();
const requestEnvelope = z.object({
  action: z.string(),
  teamId: z.string().optional(),
  payload: z.unknown(),
}).passthrough();
const readActions = new Set(["read", "result", "passes", "pass", "case", "compare", "diagnostics", "list"]);

export function deviceExperimentReads(
  experiments: Pick<Awaited<ReturnType<typeof createChatExperiments>>, "scope" | "service">,
  workspaceRequest: (raw: unknown) => Promise<unknown>,
) {
  return async (raw: unknown, desktop = false) => {
    const command = requestEnvelope.parse(raw);
    if (command.action === "deviceOwner") {
      if (!desktop) return { teamId: null };
      const { id } = lookup.parse(command.payload);
      try {
        await experiments.service.read({ teamId: experiments.scope, id });
        return { teamId: experiments.scope };
      } catch (error) {
        if (error instanceof LocalExperimentError && error.code === "local_execution_not_found") return { teamId: null };
        throw error;
      }
    }
    if (command.teamId !== experiments.scope) return workspaceRequest(raw);
    if (!desktop || !readActions.has(command.action))
      throw new LocalExperimentError("device_experiment_read_denied", "Open retained device Benchmark results in the local desktop.", 403);
    return experiments.service.request(command);
  };
}
