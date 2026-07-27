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
}) {
  const [compute, setCompute] = useState<ComputeStateResponse | null>(null);
  const [catalog, setCatalog] = useState<TrainingCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [computeTargetId, setComputeTargetId] = useState<string>(
    input.initialDestination,
  );
  const [modelSearch, setModelSearch] = useState("");
  const [deviceId, setDeviceId] = useState("automatic");

  const catalogTargets = useMemo<TrainingCatalog["targets"]>(
    () =>
      catalog?.targets
      ?? input.destinations.map((destination) => ({
        id: destination.destinationId,
        label: destinationLabel(destination.destinationId),
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
          rolloutOutputTokens: DEFAULT_ROLLOUT_OUTPUT_TOKENS,
        },
        available: destination.available,
        unavailableReason: destination.unavailableReason,
      })),
    [catalog?.targets, input.destinations],
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

  useEffect(() => {
    if (!input.connection) return;
    let active = true;
    void Promise.all([
      api.computeState(input.connection),
      api.portableTrainingCatalog(input.connection),
    ]).then(([state, nextCatalog]) => {
      if (!active) return;
      setCompute(state);
      setCatalog(nextCatalog);
      setCatalogError(null);
      setDeviceId(state.settings.defaultDeviceIds[0] ?? "automatic");
      setComputeTargetId((current) =>
        nextCatalog.targets.find((target) => target.id === current)?.id
        ?? nextCatalog.targets.find(
          (target) =>
            target.destinationId === input.initialDestination,
        )?.id
        ?? nextCatalog.targets[0]?.id
        ?? ""
      );
    }).catch((error: unknown) => {
      if (!active) return;
      setCatalogError(
        error instanceof Error
          ? error.message
          : "The training catalog could not be loaded.",
      );
    });
    return () => {
      active = false;
    };
  }, [input.connection, input.initialDestination]);

  useEffect(() => {
    if (!input.connection) return;
    let active = true;
    const query =
      modelSearch.trim().length >= 2 ? modelSearch.trim() : "";
    const timeout = window.setTimeout(() => {
      void api.portableTrainingCatalog(input.connection!, query)
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
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [input.connection, modelSearch]);

  return {
    compute,
    catalog,
    catalogError,
    catalogTargets,
    visibleCatalogModels,
    computeTargetId,
    setComputeTargetId,
    modelSearch,
    setModelSearch,
    deviceId,
    setDeviceId,
  };
}
