import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { TrainingNavigationResponse } from "@openpond/contracts";
import { api } from "../api";
import { apiFetch, type ClientConnection } from "../api/api-client";
import { connectionQueryScope } from "../lib/query-scope";

export function useTrainingNavigation(connection: ClientConnection | null, profileId: string) {
  const connectionScope = connectionQueryScope(connection);
  const navigation = useQuery({
    queryKey: ["training-navigation", connectionScope, profileId],
    queryFn: ({ signal }) =>
      apiFetch<TrainingNavigationResponse>(
        connection!,
        `/v1/training/navigation?profileId=${encodeURIComponent(profileId)}`,
        { signal },
      ),
    enabled: Boolean(connection),
    staleTime: 30_000,
    gcTime: 300_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
  const legacyNavigation = navigation.data?.projects.some(project => !Object.hasOwn(project, "baseModelId"));
  // A running development server can predate the renderer. Read its existing
  // model projection once for the missing identities, without polling it.
  const identities = useQuery({
    queryKey: ["training-navigation-model-identities", connectionScope, profileId],
    enabled: Boolean(connection && legacyNavigation),
    staleTime: Infinity,
    retry: false,
    queryFn: async ({ signal }) => {
      const library = await api.trainingState(connection!, profileId, signal, "models");
      return Object.fromEntries(library.modelProjects.map(project =>
        [project.id, project.trainingSetup?.baseModel?.modelId ?? project.defaultBaseModel?.modelId ?? null]));
    },
  });
  const data = useMemo(() => {
    const models = identities.data;
    if (!legacyNavigation || !navigation.data || !models) return navigation.data;
    return { ...navigation.data, projects: navigation.data.projects.map(project =>
      Object.hasOwn(project, "baseModelId") ? project : { ...project, baseModelId: models[project.id] ?? null }) };
  }, [legacyNavigation, navigation.data, identities.data]);
  return { ...navigation, data };
}
