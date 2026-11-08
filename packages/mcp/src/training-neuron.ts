import {
  ModelModificationCapabilitiesQuerySchema,
  ManagedNeuronTrainingCompileSchema,
  ManagedNeuronTrainingPrepareSchema,
  ManagedNeuronTrainingStartSchema,
  ManagedNeuronTrainingCancelSchema,
  ManagedNeuronTrainingExecutionListQuerySchema,
  NeuronTrainingResultSaveRequestSchema,
} from "openpond-sdk/training";
import type { AddTool, OpenPondMcpContext } from "./types.js";
import type { Clients } from "./clients.js";
import { ById, verifyPrincipal, withoutWorkspace } from "./common.js";

export function addNeuronTrainingTools(add: AddTool, c: Clients, context: OpenPondMcpContext) {
  const teamId = context.teamId;
  const owner = { ownerUserId: context.userId };
  const query = ModelModificationCapabilitiesQuerySchema.omit({ teamId: true });
  const get = (id: string) => c.training.getNeuronTrainingExecution(teamId, id, owner);
  const verifyReceipt = <T extends { execution: { teamId: string; ownerUserId: string } }>(
    receipt: T,
  ) => {
    verifyPrincipal(receipt.execution, context);
    return receipt;
  };
  add(
    "training_neuron_capabilities",
    "Check this exact model and runtime's neuron support and validation level. Source validation is distinct from GPU qualification; this reserves no capacity.",
    query,
    "read",
    async (v) =>
      verifyPrincipal(
        await c.training.neuronTrainingExecutionCapability({ ...v, teamId }),
        context,
      ),
  );
  add(
    "training_neuron_compile",
    "Compile the exact neuron form, Dataset and saved parent into a verified request. Compilation starts no compute and makes no quality claim.",
    withoutWorkspace(ManagedNeuronTrainingCompileSchema).extend({ query }),
    "read",
    async (v) =>
      verifyPrincipal(
        await c.training.compileNeuronTrainingExecution({
          ...v,
          teamId,
          query: { ...v.query, teamId },
        }),
        context,
      ),
  );
  add(
    "training_neuron_prepare",
    "Retain an exact neuron execution plan under its operation ID and maximum spend. This does not start the plan; retain its hash, revision and price approval for explicit start.",
    withoutWorkspace(ManagedNeuronTrainingPrepareSchema).extend({ query }),
    "write",
    async (v) =>
      verifyReceipt(
        await c.training.prepareNeuronTrainingExecution({
          ...v,
          teamId,
          query: { ...v.query, teamId },
        }),
      ),
    { idempotent: true, destructive: false },
  );
  add(
    "training_neuron_list",
    "List your bounded neuron execution history and retained plan identities in the connected workspace.",
    ManagedNeuronTrainingExecutionListQuerySchema,
    "read",
    (v) => c.training.listNeuronTrainingExecutions(teamId, v, owner),
  );
  add(
    "training_neuron_get",
    "Read your exact neuron execution, verified result, lifecycle and source lineage. This never restarts work.",
    ById,
    "read",
    (v) => get(v.id),
  );
  // The shared control route has no method discriminator. Read the typed owner
  // first so an ID from another method cannot launch before receipt parsing.
  add(
    "training_neuron_start",
    "Start only the exact reviewed neuron plan with its expected revision, plan hash and approved price/spend. Reuse the operation ID after uncertain delivery; may incur approved charges.",
    withoutWorkspace(ManagedNeuronTrainingStartSchema).omit({ action: true }),
    "execute",
    async (v) => {
      await get(v.id);
      return verifyReceipt(
        await c.training.startNeuronTrainingExecution({ ...v, teamId, action: "start" }),
      );
    },
    { scopes: ["app:read", "app:execute"], idempotent: true },
  );
  add(
    "training_neuron_cancel",
    "Cancel your exact retained neuron execution using its original operation ID, plan hash and expected revision. Read back actual stopping/cancelled state afterward.",
    withoutWorkspace(ManagedNeuronTrainingCancelSchema).omit({ action: true }),
    "cancel",
    async (v) => {
      await get(v.id);
      return verifyReceipt(
        await c.training.cancelNeuronTrainingExecution({ ...v, teamId, action: "cancel" }),
      );
    },
    { scopes: ["app:read", "app:cancel"], idempotent: true },
  );
  add(
    "training_neuron_save_model",
    "Save this exact completed neuron result as a Model version, pinned to result/artifact hashes and the expected Model revision. This never provisions or activates serving.",
    withoutWorkspace(NeuronTrainingResultSaveRequestSchema),
    "write",
    async (v) => {
      await get(v.executionId);
      return verifyPrincipal(
        await c.training.saveNeuronTrainingResultModel({ ...v, teamId }),
        context,
      );
    },
    { scopes: ["app:read", "app:write"], idempotent: true, destructive: false },
  );
}
