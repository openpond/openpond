import { useEffect, useMemo, useState } from "react";
import {
  type ComputeStateResponse,
  type TrainingCatalog,
  type TrainingDestinationCapabilities,
  type TrainingDestinationId,
} from "@openpond/contracts";
import { api, type ClientConnection } from "../../api";
import { destinationLabel } from "./training-start-view-helpers";

const DEFAULT_MAXIMUM_SEQUENCE_LENGTH = 4_096;
const DEFAULT_MAXIMUM_OUTPUT_TOKENS = 4_096;
const DEFAULT_ROLLOUT_OUTPUT_TOKENS = 64;

export function useTrainingCatalogState(input: {
  connection: ClientConnection | null;
  destinations: TrainingDestinationCapabilities[];
  initialDestination: TrainingDestinationId;
  method: "sft" | "dpo" | "grpo" | "ppo";
}) {
  const [compute, setCompute] = useState<ComputeStateResponse | null>(null);
  const [catalog, setCatalog] = useState<TrainingCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [modelSearch, setModelSearch] = useState("");

  const catalogTargets = useMemo<TrainingCatalog["targets"]>(
    () => {
      if (catalog?.targets) return catalog.targets;
      const destination =
        input.destinations.find(
          (candidate) =>
            candidate.destinationId === input.initialDestination,
        ) ??
        input.destinations.find((candidate) => candidate.available);
      return destination
        ? [{
        id: "automatic",
        label: "Automatic",
        description:
          destination.unavailableReason
          ?? "Server-reported training destination.",
        destinationId: destination.destinationId,
        computeAdapterId: destination.destinationId,
        runtimeAdapterId: "resolving",
        engineAdapterId: "resolving",
        methods: destination.methods,
        capabilityPills: [destinationLabel(destination.destinationId)],
        executionMode: "local_worker" as const,
        approvalPolicy: null,
        limits: {
          maximumSequenceLength: DEFAULT_MAXIMUM_SEQUENCE_LENGTH,
          maximumOutputTokens: DEFAULT_MAXIMUM_OUTPUT_TOKENS,
          maximumTrainingExamples: null,
        },
        defaults: {
          loraRank: 2,
          maxSteps: 8,
          rolloutGroupSize: 4,
          rolloutConcurrency: 1,
          rolloutOutputTokens: DEFAULT_ROLLOUT_OUTPUT_TOKENS,
        },
        available: destination.available,
        unavailableReason: destination.unavailableReason,
      }]
        : [];
    },
    [catalog?.targets, input.destinations, input.initialDestination],
  );
  const visibleCatalogModels = useMemo(() => {
    const models = catalog?.models ?? [];
    const query = modelSearch.trim().toLowerCase();
    if (!query) {
      return models.filter((model) => model.source !== "search");
    }
    return models.filter((model) =>
      `${model.label} ${model.modelId} ${model.source}`
        .toLowerCase()
        .includes(query)
    );
  }, [catalog?.models, modelSearch]);
  const computeTargetId = catalogTargets[0]?.id ?? "automatic";

  useEffect(() => {
    if (!input.connection) return;
    let active = true;
    void api.computeState(input.connection).then((state) => {
      if (active) setCompute(state);
    });
    return () => {
      active = false;
    };
  }, [input.connection]);

  useEffect(() => {
    if (!input.connection) return;
    let active = true;
    const query =
      modelSearch.trim().length >= 2 ? modelSearch.trim() : "";
    const timeout = window.setTimeout(() => {
      void api.portableTrainingCatalog(
        input.connection!,
        query,
        input.method,
      )
        .then((nextCatalog) => {
          if (!active) return;
          setCatalog(nextCatalog);
          setCatalogError(null);
        })
        .catch((error: unknown) => {
          if (!active) return;
          setCatalogError(
            error instanceof Error
              ? error.message
              : "The Model registry search could not be completed.",
          );
        });
    }, query ? 250 : 0);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [input.connection, input.method, modelSearch]);

  return {
    compute,
    catalog,
    catalogError,
    catalogTargets,
    visibleCatalogModels,
    computeTargetId,
    modelSearch,
    setModelSearch,
  };
}
