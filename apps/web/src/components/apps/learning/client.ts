import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, type ClientConnection } from "../../../api/api-client";
import type { ConversationPolicy, LearningConfiguration, LearningOptions } from "./contracts";

export function learningRequest<T>(
  connection: ClientConnection,
  teamId: string,
  resource: "options" | "policies" | "definitions" | "serving-targets",
  body?: unknown,
  signal?: AbortSignal,
) {
  return apiFetch<T>(
    connection,
    `/v1/conversation-learning/${resource}?${new URLSearchParams({ teamId })}`,
    {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    },
  );
}
export function useLearningOptions(
  connection: ClientConnection | null,
  teamId: string | null,
  accountKey: string,
  signedIn: boolean,
) {
  const cache = useQueryClient();
  const key = ["native-conversation-learning", connection?.serverUrl, accountKey, teamId];
  const query = useQuery({
    queryKey: key,
    enabled: Boolean(connection && teamId && signedIn),
    queryFn: ({ signal }) =>
      learningRequest<LearningOptions>(connection!, teamId!, "options", undefined, signal),
    staleTime: 15000,
    refetchInterval: 30000,
  });
  return { ...query, refresh: () => cache.invalidateQueries({ queryKey: key }) };
}
export function saveLearningPolicy(
  connection: ClientConnection,
  teamId: string,
  policy: ConversationPolicy | undefined,
  configuration: LearningConfiguration,
  enabled: boolean,
) {
  return learningRequest<ConversationPolicy>(connection, teamId, "policies", {
    ...(policy ? { id: policy.id } : {}),
    expectedRevision: policy?.revision ?? 0,
    configuration,
    enabled,
  });
}
