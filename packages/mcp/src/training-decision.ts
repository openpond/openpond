import {
  ModelModificationCapabilitiesQuerySchema,
  ManagedDecisionCompileSchema,
  ManagedDecisionPrepareSchema,
  ManagedDecisionStartSchema,
  ManagedDecisionCancelSchema,
  ManagedDecisionExecutionListQuerySchema,
  DecisionResultSaveRequestSchema,
} from "openpond-sdk/training";
import type { AddTool, OpenPondMcpContext } from "./types.js";
import type { Clients } from "./clients.js";
import { ById, verifyPrincipal, withoutWorkspace } from "./common.js";

export function addDecisionTraining(add: AddTool, c: Clients, context: OpenPondMcpContext) {
  const teamId = context.teamId;
  const owner = { ownerUserId: context.userId };
  const query = ModelModificationCapabilitiesQuerySchema.omit({ teamId: true });
  const get = (id: string) => c.training.getDecisionExecution(teamId, id, owner);
  const verifyReceipt = <T extends { execution: { teamId: string; ownerUserId: string } }>(
    receipt: T,
  ) => {
    verifyPrincipal(receipt.execution, context);
    return receipt;
  };
  add(
    "training_decision_capabilities",
    "Check this exact model and runtime's decision support and validation level. Source validation is distinct from GPU qualification; this reserves no capacity.",
    query,
    "read",
    async (v) =>
      verifyPrincipal(await c.training.decisionExecutionCapability({ ...v, teamId }), context),
  );
  add(
    "training_decision_compile",
    "Compile the exact decision form, Dataset and saved parent into a verified request. Compilation starts no compute and makes no quality claim.",
    withoutWorkspace(ManagedDecisionCompileSchema).extend({ query }),
    "read",
    async (v) =>
      verifyPrincipal(
        await c.training.compileDecisionExecution({ ...v, teamId, query: { ...v.query, teamId } }),
        context,
      ),
  );
  add(
    "training_decision_prepare",
    "Retain an exact decision execution plan under its operation ID and maximum spend. This does not start the plan; retain its hash, revision and price approval for explicit start.",
    withoutWorkspace(ManagedDecisionPrepareSchema).extend({ query }),
    "write",
    async (v) =>
      verifyReceipt(
        await c.training.prepareDecisionExecution({ ...v, teamId, query: { ...v.query, teamId } }),
      ),
    { idempotent: true, destructive: false },
  );
  add(
    "training_decision_list",
    "List your bounded decision execution history and retained plan identities in the connected workspace.",
    ManagedDecisionExecutionListQuerySchema,
    "read",
    (v) => c.training.listDecisionExecutions(teamId, v, owner),
  );
  add(
    "training_decision_get",
    "Read your exact decision execution, verified result, lifecycle and source lineage. This never restarts work.",
    ById,
    "read",
    (v) => get(v.id),
  );
  // The shared control route has no method discriminator. Read the typed owner
  // first so an ID from another method cannot launch before receipt parsing.
  add(
    "training_decision_start",
    "Start only the exact reviewed decision plan with its expected revision, plan hash and approved price/spend. Reuse the operation ID after uncertain delivery; may incur approved charges.",
    withoutWorkspace(ManagedDecisionStartSchema).omit({ action: true }),
    "execute",
    async (v) => {
      await get(v.id);
      return verifyReceipt(
        await c.training.startDecisionExecution({ ...v, teamId, action: "start" }),
      );
    },
    { scopes: ["app:read", "app:execute"], idempotent: true },
  );
  add(
    "training_decision_cancel",
    "Cancel your exact retained decision execution using its original operation ID, plan hash and expected revision. Read back actual stopping/cancelled state afterward.",
    withoutWorkspace(ManagedDecisionCancelSchema).omit({ action: true }),
    "cancel",
    async (v) => {
      await get(v.id);
      return verifyReceipt(
        await c.training.cancelDecisionExecution({ ...v, teamId, action: "cancel" }),
      );
    },
    { scopes: ["app:read", "app:cancel"], idempotent: true },
  );
  add(
    "training_decision_save_model",
    "Save this exact completed decision result as a Model version, pinned to result/artifact hashes and the expected Model revision. This never provisions or activates serving.",
    withoutWorkspace(DecisionResultSaveRequestSchema),
    "write",
    async (v) => {
      await get(v.executionId);
      return verifyPrincipal(await c.training.saveDecisionResultModel({ ...v, teamId }), context);
    },
    { scopes: ["app:read", "app:write"], idempotent: true, destructive: false },
  );
}
