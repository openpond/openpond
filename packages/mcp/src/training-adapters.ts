import {
  DecisionModelScoreRequestSchema,
  DecisionModelServingQuerySchema,
} from "openpond-sdk/training";
import type { AddTool, OpenPondMcpContext } from "./types.js";
import type { Clients } from "./clients.js";
import { ById, Hash, Id, verifyPrincipal, withoutWorkspace } from "./common.js";
import { addEngramTraining } from "./training-engram.js";
import { addDecisionTraining } from "./training-decision.js";
import { addNeuronTrainingTools } from "./training-neuron.js";

export function addAdapterTraining(add: AddTool, c: Clients, context: OpenPondMcpContext) {
  addEngramTraining(add, c, context);
  addDecisionTraining(add, c, context);
  addNeuronTrainingTools(add, c, context);
  add(
    "models_version_get",
    "Read a Model's exact saved version and immutable lineage. Supply versionHash to reopen a pinned version. Historical artifacts remain readable; no training or serving is started.",
    ById.extend({ versionHash: Hash.optional() }),
    "read",
    async (v) => {
      const result = await c.training.modelVersion(v.id, {
        teamId: context.teamId,
        versionHash: v.versionHash,
      });
      if (result.version) {
        verifyPrincipal(result.version, context);
        if (result.version.schemaVersion === "openpond.steeringModelVersion.v1")
          verifyPrincipal(result.version.publication, context);
      }
      return result;
    },
  );
  add(
    "decision_models_serving",
    "Inspect existing scoring capacity and readiness for this exact saved Decision version. Unavailable capacity requires an explicit separate Console action; this read never provisions it.",
    withoutWorkspace(DecisionModelServingQuerySchema).extend({ modelProjectId: Id }),
    "read",
    ({ modelProjectId, ...v }) =>
      c.training.decisionModelServing(
        modelProjectId,
        { ...v, teamId: context.teamId },
        { ownerUserId: context.userId },
      ),
  );
  add(
    "decision_models_score",
    "Score typed candidate choices with this exact saved Decision version using existing authorized capacity and bounded inference limits. May incur inference charges; this never provisions capacity or substitutes generic chat completion.",
    withoutWorkspace(DecisionModelScoreRequestSchema).extend({ modelProjectId: Id }),
    "execute",
    ({ modelProjectId, ...v }) =>
      c.training.scoreDecisionModel(
        modelProjectId,
        { ...v, teamId: context.teamId },
        { actorId: context.userId },
      ),
  );
}
