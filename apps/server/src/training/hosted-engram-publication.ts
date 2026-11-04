import { z } from "zod";
import {
  createTrainingClient,
  EngramResultSaveRequestSchema,
  type EngramResultSaveRequest,
} from "openpond-sdk/training";
import { createModelProjectsClient } from "openpond-sdk/model-projects";
import {
  ActivationExperimentAccountSchema,
  EngramModelSaveOptionsSchema,
} from "@openpond/contracts";
import { hostedApiAuthHeaders } from "../openpond/hosted-api-access.js";
import { HostedEngramExecutionError } from "./hosted-engram-executions.js";

export const HostedEngramPublicationEnvelopeSchema = ActivationExperimentAccountSchema.extend({
  projectId: z.string().min(1).max(240).nullable(),
  executionId: z.string().min(1).max(240),
  action: z.enum(["options", "save"]),
  intentHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  command: EngramResultSaveRequestSchema.optional(),
}).strict();
/** The hosted publication owner performs receipt replay before reading mutable
 * execution state. The Desktop relay never converts an observation into a Model. */
export function createHostedEngramPublication(input: {
  teamId: string;
  actorId: string;
  access: { apiBaseUrl: string; token: string };
  currentIdentity: () => Promise<{ teamId: string; actorId: string; apiOrigin: string }>;
  assertRetained: (
    command: EngramResultSaveRequest,
    intentHash: string,
    projectId: string | null,
  ) => Promise<void>;
}) {
  const origin = new URL(input.access.apiBaseUrl).origin;
  async function fence() {
    const current = await input.currentIdentity();
    if (
      current.teamId !== input.teamId ||
      current.actorId !== input.actorId ||
      new URL(current.apiOrigin).origin !== origin
    )
      throw new HostedEngramExecutionError(
        "engram_save_account_changed",
        "Recover this Model save in its original account.",
      );
  }
  const headers = hostedApiAuthHeaders(input.access.token);
  headers.set("x-openpond-team-id", input.teamId);
  const fetchScoped: typeof fetch = async (...args) => {
    await fence();
    const response = await fetch(...args);
    await fence();
    return response;
  };
  const training = createTrainingClient({
    baseUrl: input.access.apiBaseUrl,
    headers,
    fetch: fetchScoped,
  });
  const models = createModelProjectsClient({
    baseUrl: input.access.apiBaseUrl,
    headers,
    fetch: fetchScoped,
  });
  return {
    async perform(raw: unknown) {
      const body = HostedEngramPublicationEnvelopeSchema.parse(raw);
      if (
        body.teamId !== input.teamId ||
        body.actorId !== input.actorId ||
        body.apiOrigin !== origin
      )
        throw new HostedEngramExecutionError(
          "engram_save_account_changed",
          "Use the result's original configured account and workspace.",
        );
      await fence();
      if (body.action === "options") {
        const execution = await training.getEngramExecution(body.teamId, body.executionId);
        await fence();
        if (
          execution.ownerUserId !== input.actorId ||
          execution.projectId !== body.projectId ||
          execution.method !== "engram_adapter" ||
          execution.phase !== "completed" ||
          !execution.result
        )
          throw new HostedEngramExecutionError(
            "engram_save_result_unavailable",
            "Read your completed engram result before saving a Model.",
          );
        const targets = (await models.list()).filter((model) => {
          const base = model.trainingSetup.baseModel ?? model.defaultBaseModel;
          return (
            base?.modelId === execution.request.model.modelId &&
            base.revision === execution.request.model.revision
          );
        });
        await fence();
        return EngramModelSaveOptionsSchema.parse({
          account: { teamId: input.teamId, actorId: input.actorId, apiOrigin: origin },
          projectId: body.projectId,
          executionId: body.executionId,
          models: targets,
        });
      }
      const command = EngramResultSaveRequestSchema.parse(body.command);
      if (command.teamId !== body.teamId || command.executionId !== body.executionId)
        throw new HostedEngramExecutionError(
          "engram_save_scope_mismatch",
          "Retry the original result and Model save command.",
        );
      await input.assertRetained(
        command,
        z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .parse(body.intentHash),
        body.projectId,
      );
      await fence();
      const receipt = await training.saveEngramResultModel(command);
      await fence();
      if (
        receipt.actorId !== body.actorId ||
        receipt.version.source.executionId !== body.executionId
      )
        throw new HostedEngramExecutionError(
          "engram_save_receipt_mismatch",
          "The publication receipt differs from its original creator or Project.",
        );
      return receipt;
    },
  };
}
