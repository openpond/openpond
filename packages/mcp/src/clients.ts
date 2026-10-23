import {
  OpenPondExperimentsClient,
  OpenPondExperimentInspectionClient,
} from "openpond-sdk/experiments";
import { OpenPondDatasetWorkspaceClient } from "openpond-sdk/dataset-workspaces";
import { OpenPondTrainingProjectClient } from "openpond-sdk/training-projects";
import {
  OpenPondCorrectionMetricsClient,
  OpenPondGraderInspectionClient,
  OpenPondLearningClient,
} from "openpond-sdk/learning";
import { OpenPondHumanReviewClient } from "openpond-sdk/human-review";
import { OpenPondTasksetPackageClient } from "openpond-sdk/taskset-packages";
import { OpenPondTasksetCatalogClient } from "openpond-sdk/taskset-catalog";
import { createModelProjectsClient } from "openpond-sdk/model-projects";
import { createTrainingClient } from "openpond-sdk/training";
import type { OpenPondMcpOptions } from "./types.js";

export function createClients(options: OpenPondMcpOptions) {
  const origin = new URL(options.baseUrl);
  if (
    !["https:", "http:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/"
  )
    throw new Error("A clean OpenPond API origin is required.");
  if (!options.apiKey?.trim() && !options.fetch)
    throw new Error("An API credential or authenticated host transport is required.");
  const baseUrl = origin.origin;
  // This marker never authenticates a request. An injected transport must remove
  // it and bind each request to its independently verified principal. It cannot
  // accidentally reach the network through our guarded transport.
  const apiKey = options.apiKey?.trim() || "openpond-host-request-context";
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== baseUrl || !url.pathname.startsWith("/v1/"))
      throw new Error("MCP API request escaped its configured origin.");
    const headers = new Headers(request.headers);
    const requestedTeam = headers.get("x-openpond-team-id");
    if (requestedTeam && requestedTeam !== options.context.teamId)
      throw new Error("MCP workspace mismatch.");
    headers.set("x-openpond-team-id", options.context.teamId);
    if (!options.apiKey) headers.delete("authorization");
    return (options.fetch ?? globalThis.fetch)(
      new Request(request, { headers, redirect: "error" }),
    );
  };
  const config = { baseUrl, apiKey, teamId: options.context.teamId, fetch: transport };
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "X-OpenPond-Team-Id": options.context.teamId,
  };
  return {
    projects: new OpenPondTrainingProjectClient(config),
    datasets: new OpenPondDatasetWorkspaceClient(config),
    tasksets: new OpenPondTasksetCatalogClient(config),
    packages: new OpenPondTasksetPackageClient(config),
    graders: new OpenPondGraderInspectionClient(config),
    experiments: new OpenPondExperimentsClient(config),
    cases: new OpenPondExperimentInspectionClient(config),
    corrections: new OpenPondCorrectionMetricsClient(config),
    models: createModelProjectsClient({ baseUrl, fetch: transport, headers }),
    training: createTrainingClient({ baseUrl, fetch: transport, headers }),
    learning: new OpenPondLearningClient({ ...config, scope: options.context.teamId }),
    human: new OpenPondHumanReviewClient({ ...config, scope: options.context.teamId }),
  };
}
export type Clients = ReturnType<typeof createClients>;
