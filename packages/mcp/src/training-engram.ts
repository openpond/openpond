import {
  ModelModificationCapabilitiesQuerySchema,
  ManagedEngramCompileSchema,
  ManagedEngramPrepareSchema,
  ManagedEngramStartSchema,
  ManagedEngramCancelSchema,
  ManagedEngramExecutionListQuerySchema,
  EngramResultSaveRequestSchema,
} from "openpond-sdk/training";
import type { AddTool, OpenPondMcpContext } from "./types.js";
import type { Clients } from "./clients.js";
import { ById, verifyPrincipal, withoutWorkspace } from "./common.js";

export function addEngramTraining(add: AddTool, c: Clients, context: OpenPondMcpContext) {
  const teamId = context.teamId;
  const owner = { ownerUserId: context.userId };
  const query = ModelModificationCapabilitiesQuerySchema.omit({ teamId: true });
  const get = (id: string) => c.training.getEngramExecution(teamId, id, owner);
  const verifyReceipt = <T extends { execution: { teamId: string; ownerUserId: string } }>(
    receipt: T,
  ) => {
    verifyPrincipal(receipt.execution, context);
    return receipt;
  };
  add(
    "training_engram_capabilities",
    "Check this exact model and runtime's engram support and validation level. Source validation is distinct from GPU qualification; this reserves no capacity.",
    query,
    "read",
    async (v) =>
      verifyPrincipal(await c.training.engramExecutionCapability({ ...v, teamId }), context),
  );
  add(
    "training_engram_compile",
    "Compile the exact engram form, Dataset and saved parent into a verified request. Compilation starts no compute and makes no quality claim.",
    withoutWorkspace(ManagedEngramCompileSchema).extend({ query }),
    "read",
    async (v) =>
      verifyPrincipal(
        await c.training.compileEngramExecution({ ...v, teamId, query: { ...v.query, teamId } }),
        context,
      ),
  );
  add(
    "training_engram_prepare",
    "Retain an exact engram execution plan under its operation ID and maximum spend. This does not start the plan; retain its hash, revision and price approval for explicit start.",
    withoutWorkspace(ManagedEngramPrepareSchema).extend({ query }),
    "write",
    async (v) =>
      verifyReceipt(
        await c.training.prepareEngramExecution({ ...v, teamId, query: { ...v.query, teamId } }),
      ),
    { idempotent: true, destructive: false },
  );
  add(
    "training_engram_list",
    "List your bounded engram execution history and retained plan identities in the connected workspace.",
    ManagedEngramExecutionListQuerySchema,
    "read",
    (v) => c.training.listEngramExecutions(teamId, v, owner),
  );
  add(
    "training_engram_get",
    "Read your exact engram execution, verified result, lifecycle and source lineage. This never restarts work.",
    ById,
    "read",
    (v) => get(v.id),
  );
  // The shared control route has no method discriminator. Read the typed owner
  // first so an ID from another method cannot launch before receipt parsing.
  add(
    "training_engram_start",
    "Start only the exact reviewed engram plan with its expected revision, plan hash and approved price/spend. Reuse the operation ID after uncertain delivery; may incur approved charges.",
    withoutWorkspace(ManagedEngramStartSchema).omit({ action: true }),
    "execute",
    async (v) => {
      await get(v.id);
      return verifyReceipt(
        await c.training.startEngramExecution({ ...v, teamId, action: "start" }),
      );
    },
    { scopes: ["app:read", "app:execute"], idempotent: true },
  );
  add(
    "training_engram_cancel",
    "Cancel your exact retained engram execution using its original operation ID, plan hash and expected revision. Read back actual stopping/cancelled state afterward.",
    withoutWorkspace(ManagedEngramCancelSchema).omit({ action: true }),
    "cancel",
    async (v) => {
      await get(v.id);
      return verifyReceipt(
        await c.training.cancelEngramExecution({ ...v, teamId, action: "cancel" }),
      );
    },
    { scopes: ["app:read", "app:cancel"], idempotent: true },
  );
  add(
    "training_engram_save_model",
    "Save this exact completed engram result as a Model version, pinned to result/artifact hashes and the expected Model revision. This never provisions or activates serving.",
    withoutWorkspace(EngramResultSaveRequestSchema),
    "write",
    async (v) => {
      await get(v.executionId);
      return verifyPrincipal(await c.training.saveEngramResultModel({ ...v, teamId }), context);
    },
    { scopes: ["app:read", "app:write"], idempotent: true, destructive: false },
  );
}
