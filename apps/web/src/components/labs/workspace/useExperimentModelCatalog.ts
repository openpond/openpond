import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { ModelProjectBaseModelSchema } from "openpond-sdk/model-projects";
import { canonicalJson, type ExperimentStartingModel } from "openpond-sdk/training";
import { connectionQueryScope } from "../../../lib/query-scope";
import { useEvaluationSetup } from "./EvaluationSetupState";
import { experimentModelSourceKey } from "./experiment-starting-model";
import type { WorkspaceApi } from "./workspace-api";

const Catalog = z
  .object({
    models: z
      .array(
        z
          .object({
            id: z.string().min(1).max(500),
            name: z.string().min(1).max(500),
            supportsSampling: z.boolean(),
            baseModel: ModelProjectBaseModelSchema.nullable().optional(),
          })
          .strict(),
      )
      .max(200),
  })
  .strict()
  .superRefine(({ models }, context) => {
    if (new Set(models.map((model) => model.id)).size !== models.length)
      context.addIssue({
        code: "custom",
        message: "The model catalog repeated an inference identity.",
      });
  });
export type ExperimentModelChoice = z.infer<typeof Catalog>["models"][number];
export function useExperimentModelCatalog(api: WorkspaceApi, enabled = true) {
  return useQuery({
    queryKey: [
      "evaluation-workspace",
      api.key,
      connectionQueryScope(api.connection),
      "samplingModels",
    ],
    enabled,
    queryFn: async ({ signal }) => Catalog.parse(await api.request("graderModels", {}, signal)),
    staleTime: 30_000,
    retry: false,
  });
}

/** A captured base pin never follows a subsequently changed inference alias.
 * Only an explicit new picker selection changes that original weight source. */
export function resolveExperimentModelLink(
  selected: ExperimentStartingModel,
  models: ExperimentModelChoice[],
) {
  if (
    selected.source === "trained" ||
    selected.source === "steering" ||
    selected.source === "engram" ||
    selected.source === "decision" ||
    selected.source === "alphaedit" ||
    selected.source === "neuron_training"
  )
    return { baseModel: selected.baseModel, inferenceModelId: null };
  const exactBase = (model: ExperimentModelChoice) =>
    model.baseModel?.revision ? model.baseModel : null;
  if (selected.source === "inference") {
    const model = models.find((model) => model.id === selected.inferenceModelId);
    const baseModel = selected.baseModel ?? (model ? exactBase(model) : null);
    const sameBase =
      !baseModel ||
      Boolean(
        model && exactBase(model) && canonicalJson(exactBase(model)) === canonicalJson(baseModel),
      );
    return { baseModel, inferenceModelId: model && sameBase ? model.id : null };
  }
  const matches = models.filter(
    (model) =>
      exactBase(model) && canonicalJson(exactBase(model)) === canonicalJson(selected.baseModel),
  );
  const retained = matches.find((model) => model.id === selected.inferenceModelId);
  return {
    baseModel: selected.baseModel,
    inferenceModelId: retained?.id ?? (matches.length === 1 ? matches[0]!.id : null),
  };
}
export function useExperimentModelContinuity(api: WorkspaceApi) {
  const setup = useEvaluationSetup();
  const selected = setup.startingModel,
    sourceKey = experimentModelSourceKey(selected);
  const catalog = useExperimentModelCatalog(
    api,
    Boolean(
      selected &&
      selected.source !== "trained" &&
      selected.source !== "steering" &&
      selected.source !== "engram" &&
      selected.source !== "decision" &&
      selected.source !== "alphaedit" &&
      selected.source !== "neuron_training",
    ),
  );
  const apply = setup.applyModelCatalogLink;
  useEffect(() => {
    if (!selected) return;
    const link = catalog.isSuccess
      ? resolveExperimentModelLink(selected, catalog.data.models)
      : { baseModel: selected.baseModel, inferenceModelId: null };
    apply(sourceKey, link);
  }, [sourceKey, selected, catalog.isSuccess, catalog.data, apply]);
  return catalog;
}
