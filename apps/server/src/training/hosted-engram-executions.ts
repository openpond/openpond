import { ActivationExperimentAccountSchema } from "@openpond/contracts";
import { z } from "zod";
import {
  canonicalJson, createTrainingClient, ModelModificationCapabilitiesQuerySchema, ManagedEngramExecutionMetadataSchema, ManagedEngramCompileSchema, ManagedEngramPrepareSchema,
  ManagedEngramStartSchema, ManagedEngramCancelSchema, ManagedEngramExecutionListQuerySchema,
  type ManagedEngramPrepare, type ManagedEngramStart, type ManagedEngramCancel,
} from "openpond-sdk/training";
import { hostedApiAuthHeaders } from "../openpond/hosted-api-access.js";

const Id = z.string().trim().min(1).max(240);
export const HostedEngramExecutionEnvelopeSchema = ActivationExperimentAccountSchema.extend({
  projectId: Id.nullable(),
  action: z.enum(["capability", "compile", "prepare", "start", "cancel", "get", "list"]),
  id: Id.optional(), intentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  command: z.unknown().optional(), query: ManagedEngramExecutionListQuerySchema.optional(), capabilityQuery: ModelModificationCapabilitiesQuerySchema.optional(),
}).strict();
export class HostedEngramExecutionError extends Error {
  readonly status = 409;
  constructor(readonly code: string, message: string) { super(message); }
}
/** The configured hosted account is the only dispatch authority. The caller's
 * pin is compared with that account; it is never used as a fetch destination. */
export function createHostedEngramExecutions(input: {
  teamId: string; actorId: string; access: {apiBaseUrl: string; token: string};
  currentIdentity: () => Promise<{teamId: string; actorId: string; apiOrigin: string} | null>;
  assertRetained: (value: {action: "prepare" | "start" | "cancel"; intentHash: string;
    projectId: string | null; command: ManagedEngramPrepare | ManagedEngramStart | ManagedEngramCancel}) => Promise<z.infer<typeof ManagedEngramExecutionMetadataSchema> | null>;
}) {
  const apiOrigin = new URL(input.access.apiBaseUrl).origin;
  async function fence() {
    const current = await input.currentIdentity();
    if (!current || current.teamId !== input.teamId || current.actorId !== input.actorId || new URL(current.apiOrigin).origin !== apiOrigin)
      throw new HostedEngramExecutionError("engram_account_changed", "The active account changed. Recover this experiment in its original account.");
  }
  const train = createTrainingClient({baseUrl: input.access.apiBaseUrl, headers: () => {
    const headers = hostedApiAuthHeaders(input.access.token); headers.set("x-openpond-team-id", input.teamId); return headers;
  }, fetch: async (...args) => {await fence(); const response = await fetch(...args); await fence(); return response;}});
  return {async perform(raw: unknown) {
    const body = HostedEngramExecutionEnvelopeSchema.parse(raw);
    if (body.teamId !== input.teamId || body.actorId !== input.actorId || body.apiOrigin !== apiOrigin)
      throw new HostedEngramExecutionError("engram_account_changed", "This experiment belongs to another account or hosted API.");
    await fence();
    if (body.action === "capability") {
      const query = ModelModificationCapabilitiesQuerySchema.parse(body.capabilityQuery);
      if (query.teamId !== body.teamId) throw scopeError();
      const capability = await train.engramExecutionCapability(query);
      await fence();
      if (capability.actorId !== body.actorId) throw scopeError();
      return capability;
    }
    if (body.action === "compile") {
      const command = ManagedEngramCompileSchema.parse(body.command);
      if (command.teamId !== body.teamId || command.projectId !== body.projectId) throw scopeError();
      const compiled = await train.compileEngramExecution(command);
      await fence();
      if (compiled.actorId !== body.actorId) throw scopeError();
      return compiled;
    }
    if (body.action === "list") {
      const query = ManagedEngramExecutionListQuerySchema.parse(body.query ?? {});
      if (body.projectId !== null && query.projectId !== body.projectId) throw scopeError();
      const page = await train.listEngramExecutions(body.teamId, query, {ownerUserId: body.actorId});
      await fence(); return page;
    }
    if (body.action === "get") {
      const execution = await train.getEngramExecution(body.teamId, Id.parse(body.id));
      await fence();
      if (execution.ownerUserId !== body.actorId || execution.projectId !== body.projectId) throw scopeError();
      return execution;
    }
    const command = body.action === "prepare" ? ManagedEngramPrepareSchema.parse(body.command)
      : body.action === "start" ? ManagedEngramStartSchema.parse(body.command) : ManagedEngramCancelSchema.parse(body.command);
    if (command.teamId !== body.teamId || ("projectId" in command && command.projectId !== body.projectId)
      || ("id" in command && command.id !== body.id)) throw scopeError();
    const historical = await input.assertRetained({action: body.action, projectId: body.projectId, command,
      intentHash: z.string().regex(/^[a-f0-9]{64}$/).parse(body.intentHash)});
    await fence();
    if (historical && "action" in command) {
      // Retained review metadata is immutable evidence, not a prerequisite GET.
      // The hosted owner reauthorizes and reconciles the original receipt first.
      const original = ManagedEngramExecutionMetadataSchema.parse(historical);
      if (original.id !== command.id || original.teamId !== body.teamId || original.ownerUserId !== body.actorId
        || original.projectId !== body.projectId || original.plan.contentHash !== command.planHash
        || original.revision !== command.expectedRevision
        || command.action === "start" && original.plan.maximumSpendUsd !== command.approvedMaximumSpendUsd) throw scopeError();
    }
    const receipt = "action" in command ? command.action === "start" ? await train.startEngramExecution(command)
      : await train.cancelEngramExecution(command) : await train.prepareEngramExecution(command);
    await fence();
    if (receipt.execution.ownerUserId !== body.actorId || receipt.execution.projectId !== body.projectId
      || historical && (receipt.execution.sourceContentHash !== historical.sourceContentHash || canonicalJson(receipt.execution.plan) !== canonicalJson(historical.plan))) throw scopeError();
    return receipt;
  }};
}
function scopeError() {
  return new HostedEngramExecutionError("engram_scope_mismatch", "Retain the exact experiment, creator, workspace and Project before continuing.");
}
