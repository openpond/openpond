import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { ToolLearningInstallationSchema } from "openpond-sdk/tool-learning";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import type { Inventory } from "../labs/workspace/workspace-api";

export type FixItContext = { connection: ClientConnection; teamId: string; accountKey: string };
export function fixItRequest<T>(context: FixItContext, operation: string, value: unknown = {}, signal?: AbortSignal) {
  return apiFetch<T>(context.connection, "/v1/training/evaluation-workspace", {
    method: "POST", body: JSON.stringify({ teamId: context.teamId, projectId: null, operation, value }), signal,
  });
}
export function useCaptureDestination(context: FixItContext) {
  return useQuery({ queryKey: ["capture-destination", context.connection.serverUrl, context.accountKey, context.teamId],
    queryFn: async ({ signal }) => {
      const inventory = await fixItRequest<Inventory>(context, "inventory", {}, signal);
      return inventory.datasets.datasets.find(item => item.id.startsWith("tool-captures-")) ?? null;
    }, staleTime: 10_000, refetchInterval: 15_000 });
}
export function useToolConnections(context: FixItContext) {
  return useQuery({ queryKey: ["tool-connections", context.connection.serverUrl, context.accountKey, context.teamId],
    queryFn: async ({ signal }) => z.object({ installations: z.array(ToolLearningInstallationSchema) }).parse(
      await fixItRequest(context, "toolConnections", {}, signal)), staleTime: 30_000 });
}
