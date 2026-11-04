import { useMemo } from "react";
import { OpenPondLearningClient } from "openpond-sdk/learning";
import { connectionQueryScope, scopeLearningClient } from "../../../lib/query-scope";
import type { WorkspaceApi } from "./workspace-api";

/** Hosted examples/graders share the existing authenticated Desktop relay.
 * The renderer holds no hosted API credential and cannot change its scope. */
export function useWorkspaceLearningClient(api: WorkspaceApi) {
  const credentialScope = connectionQueryScope(api.connection);
  return useMemo(
    () =>
      scopeLearningClient(
        new OpenPondLearningClient({
          baseUrl: "https://desktop.openpond.invalid",
          apiKey: "desktop-server-boundary",
          scope: api.teamId,
          fetch: async (url, init) => {
            const endpoint = new URL(String(url)).pathname.split("/").at(-1);
            if (endpoint !== "read" && endpoint !== "commands")
              throw new Error("Unsupported workspace learning action.");
            const result = await api.request(
              "learningRelay",
              { endpoint, request: JSON.parse(String(init?.body)) },
              init?.signal ?? undefined,
            );
            return new Response(JSON.stringify(result), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          },
        }),
        ["learning", "hosted-evaluation-workspace", credentialScope, api.key],
      ),
    [api, credentialScope],
  );
}
