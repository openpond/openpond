import { trainingRoutes as routes, dynamicTrainingRoutes as dynamic } from "./training-route-tables.js";
import { handleAlphaEditPublicationRoutes } from "./alphaedit-publication-routes.js";
import { handleHostedAlphaEditRoutes } from "./hosted-alphaedit-routes.js";
import { handleNeuronTrainingPublicationRoutes } from "./neuron-training-publication-routes.js";
import { handleHostedNeuronTrainingRoutes } from "./hosted-neuron-training-routes.js";
import { handleDecisionScoringRoutes } from "./decision-scoring-routes.js";
import { handleDecisionPublicationRoutes } from "./decision-publication-routes.js";
import { handleHostedDecisionRoutes } from "./hosted-decision-routes.js";
import { HostedDecisionExecutionError } from "../../training/hosted-decision-executions.js";
import { handleEngramPublicationRoutes } from "./engram-publication-routes.js";
import { handleHostedEngramRoutes } from "./hosted-engram-routes.js";
import { handleSteeringPublicationRoutes } from "./steering-publication-routes.js";
import { handleHostedModificationRoutes } from "./hosted-modification-routes.js";
import { OpenPondExperimentError } from "openpond-sdk/experiments";
import { OpenPondLearningError } from "openpond-sdk/learning";
import { OpenPondTrainingApiError } from "openpond-sdk/training";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { ZodError, z } from "zod";
import { OpenPondModelProjectApiError } from "openpond-sdk/model-projects";
import { OpenPondModelStarterCatalogError } from "openpond-sdk/model-starter-catalog";
import { ModelBatchReviewError } from "openpond-sdk/taskset-packages";
import { LearningDomainError } from "@openpond/evals/learning";
import { readJson, sendBinary, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";
import {
  streamTrainingArtifactPackage,
  trainingArtifactPackageSize,
  type TrainingArtifactPackage,
} from "../../training/training-artifact-package.js";

export async function handleTrainingRoutes({
  deps,
  request,
  requestUrl,
  response,
}: HttpRouteContext): Promise<boolean> {
  if (!requestUrl.pathname.startsWith("/v1/training")) return false;
  if (await handleAlphaEditPublicationRoutes({ deps, request, requestUrl, response })) return true;
  if (await handleNeuronTrainingPublicationRoutes({ deps, request, requestUrl, response }))
    return true;
  if (await handleHostedAlphaEditRoutes({ deps, request, requestUrl, response })) return true;
  if (await handleHostedNeuronTrainingRoutes({ deps, request, requestUrl, response })) return true;
  if (await handleDecisionScoringRoutes({ deps, request, requestUrl, response })) return true;
  if (await handleDecisionPublicationRoutes({ deps, request, requestUrl, response })) return true;
  if (await handleHostedDecisionRoutes({ deps, request, requestUrl, response })) return true;
  if (await handleEngramPublicationRoutes({ deps, request, requestUrl, response })) return true;
  if (await handleSteeringPublicationRoutes({ deps, request, requestUrl, response })) return true;
  if (await handleHostedEngramRoutes({ deps, request, requestUrl, response })) return true;
  if (await handleHostedModificationRoutes({ deps, request, requestUrl, response })) return true;
  if (
    request.method === "POST" &&
    [
      "/v1/training/model-project-preparations/prepare",
      "/v1/training/model-project-preparations/apply",
    ].includes(requestUrl.pathname)
  ) {
    try {
      const action = requestUrl.pathname.endsWith("/apply")
        ? "apply_local_model_project_preparation"
        : "prepare_local_model_project";
      response.setHeader("Cache-Control", "no-store");
      sendJson(
        response,
        200,
        await deps.trainingPayload(
          action,
          await readJson(request, { maxBytes: 67_108_864 }),
          requestUrl,
        ),
      );
    } catch (error) {
      if (error instanceof ZodError)
        sendJson(response, 400, {
          code: "model_preparation_invalid",
          error: "Project preparation does not match its contract.",
        });
      else if (error instanceof Error)
        sendJson(response, 409, { code: "model_preparation_conflict", error: error.message });
      else throw error;
    }
    return true;
  }
  const candidate =
    /^\/v1\/training\/candidate-evaluations(?:\/([^/]+)(?:\/(prepare|run|cancel))?)?$/.exec(
      requestUrl.pathname,
    );
  if (
    (requestUrl.pathname === "/v1/training/candidates" && request.method === "GET") ||
    (candidate &&
      ((request.method === "GET" && candidate[1] && !candidate[2]) ||
        (request.method === "POST" && (!candidate[1] || candidate[2]))))
  ) {
    const body =
      request.method === "POST" ? await readJson(request, { maxBytes: 8_388_608 }) : undefined;
    response.setHeader("Cache-Control", "no-store");
    sendJson(
      response,
      200,
      await deps.trainingPayload(
        "hosted_candidate_evaluation",
        {
          teamId:
            requestUrl.searchParams.get("teamId") ??
            (body && typeof body === "object" && "teamId" in body ? body.teamId : null),
          action:
            requestUrl.pathname === "/v1/training/candidates"
              ? "options"
              : (candidate?.[2] ?? (request.method === "GET" ? "read" : "save")),
          ...(candidate?.[1] ? { id: decodeURIComponent(candidate[1]) } : {}),
          ...(body === undefined ? {} : { command: body }),
          ...(requestUrl.pathname === "/v1/training/candidates"
            ? {
                query: {
                  ...(requestUrl.searchParams.get("afterId")
                    ? { afterId: requestUrl.searchParams.get("afterId")! }
                    : {}),
                  ...(requestUrl.searchParams.get("projectId")
                    ? { projectId: requestUrl.searchParams.get("projectId")! }
                    : {}),
                },
              }
            : {}),
        },
        requestUrl,
      ),
    );
    return true;
  }
  const hostedPolicy = /^\/v1\/training\/hosted-policies\/([^/]+)(\/control)?$/.exec(
    requestUrl.pathname,
  );
  if (
    hostedPolicy &&
    ((request.method === "GET" && !hostedPolicy[2]) ||
      (request.method === "POST" && hostedPolicy[2]))
  ) {
    response.setHeader("Cache-Control", "no-store");
    sendJson(
      response,
      200,
      await deps.trainingPayload(
        "hosted_training_policy",
        {
          teamId: requestUrl.searchParams.get("teamId"),
          id: decodeURIComponent(hostedPolicy[1]!),
          ...(hostedPolicy[2]
            ? { command: await readJson(request, { maxBytes: 262_144 }) }
            : { afterId: requestUrl.searchParams.get("afterId") }),
        },
        requestUrl,
      ),
    );
    return true;
  }
  if (requestUrl.pathname === "/v1/training/setup/draft-inputs" && request.method === "GET") {
    response.setHeader("Cache-Control", "no-store");
    sendJson(
      response,
      200,
      await deps.trainingPayload(
        "hosted_training_setup",
        {
          teamId: requestUrl.searchParams.get("teamId"),
          draftInputs: true,
          projectId: requestUrl.searchParams.get("projectId"),
          cursor: requestUrl.searchParams.get("cursor"),
        },
        requestUrl,
      ),
    );
    return true;
  }
  const draftSetup = /^\/v1\/training\/setup\/drafts(?:\/([^/]+)(\/archive)?)?$/.exec(
    requestUrl.pathname,
  );
  if (
    draftSetup &&
    ((request.method === "GET" && !draftSetup[2]) ||
      (request.method === "POST" && (!draftSetup[1] || draftSetup[2])))
  ) {
    const id = draftSetup[1] ? decodeURIComponent(draftSetup[1]) : null;
    const query = Object.fromEntries(requestUrl.searchParams);
    const { teamId, limit, archived, ...filters } = query;
    const command =
      request.method === "POST" ? await readJson(request, { maxBytes: 32_768 }) : null;
    response.setHeader("Cache-Control", "no-store");
    sendJson(
      response,
      200,
      await deps.trainingPayload(
        "hosted_training_setup",
        {
          teamId,
          action:
            request.method === "GET"
              ? id
                ? "get-draft"
                : "list-drafts"
              : id
                ? "archive-draft"
                : "save-draft",
          command:
            request.method === "POST"
              ? id
                ? { id, control: command }
                : command
              : id
                ? { id }
                : {
                    ...filters,
                    ...(limit === undefined ? {} : { limit: Number(limit) }),
                    ...(archived === undefined
                      ? {}
                      : { archived: z.enum(["true", "false"]).parse(archived) === "true" }),
                  },
        },
        requestUrl,
      ),
    );
    return true;
  }
  const trainingSetup =
    /^\/v1\/training\/setup(?:\/(prepare|prepare-draft|review-dataset|start|cancel|publish|attach|estimate|funding|funding-handoff|hardware-catalog|gpu-catalog|modification-capabilities))?$/.exec(
      requestUrl.pathname,
    );
  if (
    trainingSetup &&
    ((request.method === "GET" && !trainingSetup[1]) ||
      (request.method === "POST" && trainingSetup[1]))
  ) {
    response.setHeader("Cache-Control", "no-store");
    sendJson(
      response,
      200,
      await deps.trainingPayload(
        "hosted_training_setup",
        {
          teamId: requestUrl.searchParams.get("teamId"),
          ...(trainingSetup[1]
            ? {
                action: trainingSetup[1],
                command: await readJson(request, { maxBytes: 8_388_608 }),
              }
            : {
                configurationId: requestUrl.searchParams.get("configurationId"),
                projectId: requestUrl.searchParams.get("projectId"),
              }),
        },
        requestUrl,
      ),
    );
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/v1/training/experiment-handoff") {
    response.setHeader("Cache-Control", "no-store");
    sendJson(
      response,
      200,
      await deps.trainingPayload(
        "experiment_training_handoff",
        {
          teamId: requestUrl.searchParams.get("teamId"),
          executionId: requestUrl.searchParams.get("executionId"),
          passId: requestUrl.searchParams.get("passId"),
        },
        requestUrl,
      ),
    );
    return true;
  }
  const modelServing = /^\/v1\/training\/saved-models\/([^/]+)\/serving$/.exec(requestUrl.pathname);
  if (modelServing && request.method === "POST") {
    response.setHeader("Cache-Control", "no-store");
    try {
      sendJson(
        response,
        200,
        await deps.trainingPayload(
          "hosted_training_model_serving_control",
          {
            teamId: requestUrl.searchParams.get("teamId"),
            modelProjectId: decodeURIComponent(modelServing[1]!),
            command: await readJson(request, { maxBytes: 32_768 }),
            ...(requestUrl.searchParams.has("intentHash")
              ? {
                  review: {
                    intentHash: requestUrl.searchParams.get("intentHash"),
                    projectId: requestUrl.searchParams.get("projectId"),
                  },
                }
              : {}),
          },
          requestUrl,
        ),
      );
    } catch (error) {
      if (error instanceof OpenPondTrainingApiError)
        sendJson(response, error.status, {
          code: error.code,
          error: error.message,
          retryable: error.retryable,
        });
      else if (error instanceof HostedDecisionExecutionError)
        sendJson(response, error.status, {
          code: error.code,
          error: error.message,
          retryable: false,
        });
      else throw error;
    }
    return true;
  }
  if (modelServing && request.method === "GET") {
    response.setHeader("Cache-Control", "no-store");
    sendJson(
      response,
      200,
      await deps.trainingPayload(
        "hosted_training_model_serving",
        {
          teamId: requestUrl.searchParams.get("teamId"),
          modelProjectId: decodeURIComponent(modelServing[1]!),
          versionHash: requestUrl.searchParams.get("versionHash"),
        },
        requestUrl,
      ),
    );
    return true;
  }
  const savedVersion = /^\/v1\/training\/saved-models\/([^/]+)\/version$/.exec(requestUrl.pathname);
  if (savedVersion && request.method === "GET") {
    response.setHeader("Cache-Control", "no-store");
    sendJson(
      response,
      200,
      await deps.trainingPayload(
        "hosted_training_saved_version",
        {
          teamId: requestUrl.searchParams.get("teamId"),
          modelProjectId: decodeURIComponent(savedVersion[1]!),
          ...(requestUrl.searchParams.has("versionHash")
            ? { versionHash: requestUrl.searchParams.get("versionHash") }
            : {}),
        },
        requestUrl,
      ),
    );
    return true;
  }
  const savedModel = /^\/v1\/training\/saved-models\/([^/]+)$/.exec(requestUrl.pathname);
  if (savedModel && request.method === "GET") {
    response.setHeader("Cache-Control", "no-store");
    sendJson(
      response,
      200,
      await deps.trainingPayload(
        "hosted_training_saved_model",
        {
          teamId: requestUrl.searchParams.get("teamId"),
          modelProjectId: decodeURIComponent(savedModel[1]!),
        },
        requestUrl,
      ),
    );
    return true;
  }
  const saveModel = /^\/v1\/training\/hosted-jobs\/([^/]+)\/model$/.exec(requestUrl.pathname);
  if (saveModel && request.method === "POST") {
    response.setHeader("Cache-Control", "no-store");
    try {
      sendJson(
        response,
        200,
        await deps.trainingPayload(
          "hosted_training_save_model",
          {
            teamId: requestUrl.searchParams.get("teamId"),
            jobId: decodeURIComponent(saveModel[1]!),
            command: await readJson(request, { maxBytes: 32_768 }),
          },
          requestUrl,
        ),
      );
    } catch (error) {
      if (error instanceof OpenPondTrainingApiError)
        sendJson(response, error.status, {
          code: error.code,
          error: error.message,
          retryable: error.retryable,
        });
      else throw error;
    }
    return true;
  }
  const hostedJob =
    /^\/v1\/training\/hosted-jobs\/([^/]+)(?:\/(result|flow|summary|logs|feedback)|\/post-training\/(start|retry|cancel))?$/.exec(
      requestUrl.pathname,
    );
  if (
    hostedJob &&
    ((request.method === "GET" && !hostedJob[3]) || (request.method === "POST" && hostedJob[3]))
  ) {
    response.setHeader("Cache-Control", "no-store");
    const payload = {
      teamId: requestUrl.searchParams.get("teamId"),
      jobId: decodeURIComponent(hostedJob[1]!),
      ...(hostedJob[2] === "feedback"
        ? {
            feedbackTarget: {
              kind: requestUrl.searchParams.get("kind"),
              id: requestUrl.searchParams.get("id"),
              ...(requestUrl.searchParams.has("taskId")
                ? { taskId: requestUrl.searchParams.get("taskId") }
                : {}),
            },
          }
        : {}),
      ...(hostedJob[3]
        ? { action: hostedJob[3], command: await readJson(request, { maxBytes: 65_536 }) }
        : {}),
      ...(!hostedJob[2] && !hostedJob[3]
        ? { includeFlow: requestUrl.searchParams.get("graph") !== "false" }
        : {}),
    };
    sendJson(
      response,
      200,
      await deps.trainingPayload(
        hostedJob[3]
          ? "hosted_training_control"
          : hostedJob[2]
            ? `hosted_training_${hostedJob[2]}`
            : "hosted_training_detail",
        payload,
        requestUrl,
      ),
    );
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/v1/training/execution-activity") {
    response.setHeader("Cache-Control", "no-store");
    const teamId = requestUrl.searchParams.get("teamId");
    const projectId = requestUrl.searchParams.get("projectId");
    sendJson(
      response,
      200,
      await deps.trainingPayload("execution_activity", { teamId, projectId }, requestUrl),
    );
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/v1/training/evaluation-workspace") {
    response.setHeader("Cache-Control", "no-store");
    try {
      sendJson(
        response,
        200,
        await deps.trainingPayload(
          "evaluation_workspace",
          await readJson(request, { maxBytes: 67_108_864 }),
          requestUrl,
        ),
      );
    } catch (error) {
      if (error instanceof ZodError)
        sendJson(response, 400, {
          code: "evaluation_workspace_request_invalid",
          error: "The evaluation request does not match its contract.",
        });
      else if (error instanceof OpenPondExperimentError || error instanceof OpenPondLearningError)
        sendJson(response, error.status, { code: error.code, error: error.message });
      else throw error;
    }
    return true;
  }
  if (
    request.method === "POST" &&
    ["/v1/training/models/batch-review", "/v1/training/models/batch-review/inspect"].includes(
      requestUrl.pathname,
    )
  ) {
    try {
      const result = await deps.trainingPayload(
        requestUrl.pathname.endsWith("/inspect")
          ? "inspect_model_batch_review"
          : "begin_model_batch_review",
        await readJson(request, { maxBytes: 16_777_216 }),
        requestUrl,
      );
      response.setHeader("Cache-Control", "no-store");
      sendJson(response, 200, result);
    } catch (error) {
      if (error instanceof LearningDomainError || error instanceof ModelBatchReviewError)
        sendJson(response, error.status, { code: error.code, error: error.message });
      else if (error instanceof ZodError)
        sendJson(response, 400, {
          code: "model_review_request_invalid",
          error: "Model review request does not match its contract.",
        });
      else throw error;
    }
    return true;
  }
  if (
    (request.method === "GET" && requestUrl.pathname === "/v1/training/model-starters") ||
    (request.method === "POST" &&
      [
        "/v1/training/model-starters/preview",
        "/v1/training/model-starters/check",
        "/v1/training/model-starters/create",
      ].includes(requestUrl.pathname))
  ) {
    try {
      const listing = request.method === "GET";
      const action = listing
        ? "model_starter_catalog"
        : requestUrl.pathname.endsWith("/preview")
          ? "model_starter_preview"
          : requestUrl.pathname.endsWith("/check")
            ? "check_model_starter"
            : "create_model_from_starter";
      const query = Object.fromEntries(requestUrl.searchParams);
      const body = listing
        ? { ...query, ...(query.limit === undefined ? {} : { limit: Number(query.limit) }) }
        : await readJson(request, { maxBytes: 65_536 });
      sendJson(response, 200, await deps.trainingPayload(action, body, requestUrl));
    } catch (error) {
      if (error instanceof OpenPondModelStarterCatalogError)
        sendJson(response, error.status, { code: error.code, error: error.message });
      else if (error instanceof ZodError)
        sendJson(response, 400, {
          code: "model_starter_request_invalid",
          error: "Starter request or publication does not match its contract.",
        });
      else throw error;
    }
    return true;
  }
  if (
    (request.method === "PUT" && requestUrl.pathname === "/v1/training/models") ||
    (request.method === "POST" && requestUrl.pathname === "/v1/training/models/check")
  ) {
    try {
      sendJson(
        response,
        200,
        await deps.trainingPayload(
          request.method === "PUT" ? "save_model_project" : "check_model_project",
          await readJson(request, { maxBytes: 524_288 }),
          requestUrl,
        ),
      );
    } catch (error) {
      if (error instanceof OpenPondModelProjectApiError)
        sendJson(response, error.status, {
          code: error.code,
          error: error.message,
          retryable: error.retryable,
        });
      else if (error instanceof ZodError)
        sendJson(response, 400, {
          code: "model_configuration_invalid",
          error: "Model configuration does not match its contract.",
        });
      else throw error;
    }
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/v1/training") {
    sendJson(response, 200, await deps.trainingPayload("state", {}, requestUrl));
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/v1/training/navigation") {
    sendJson(response, 200, await deps.trainingPayload("navigation", {}, requestUrl));
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/v1/training/activity") {
    sendJson(response, 200, await deps.trainingPayload("activity", {}, requestUrl));
    return true;
  }
  const conversationServing =
    /^\/v1\/training\/models\/([^/]+)\/conversation-serving(?:\/(register|authorize|revoke))?$/.exec(
      requestUrl.pathname,
    );
  if (
    conversationServing &&
    ((request.method === "GET" && !conversationServing[2]) ||
      (request.method === "POST" && conversationServing[2]))
  ) {
    try {
      const scope = {
        modelId: decodeURIComponent(conversationServing[1]!),
        profileId: requestUrl.searchParams.get("profileId"),
      };
      const payload =
        request.method === "POST"
          ? { ...((await readJson(request, { maxBytes: 65536 })) as object), ...scope }
          : scope;
      const result = await deps.trainingPayload(
        `conversation_serving_${conversationServing[2] ?? "state"}`,
        payload,
        requestUrl,
      );
      response.setHeader("Cache-Control", "no-store");
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, error instanceof ZodError ? 400 : 409, {
        code: "conversation_serving_request_failed",
        error:
          error instanceof Error
            ? error.message
            : "The native serving owner could not complete this operation.",
      });
    }
    return true;
  }
  const hostedLearning =
    /^\/v1\/training\/models\/([^/]+)\/hosted-learning(\/sources|\/review)?$/.exec(
      requestUrl.pathname,
    );
  if (
    hostedLearning &&
    ((request.method === "GET" && hostedLearning[2] !== "/review") ||
      (request.method === "POST" && hostedLearning[2] !== "/sources"))
  ) {
    const scope = {
      modelId: decodeURIComponent(hostedLearning[1]!),
      profileId: requestUrl.searchParams.get("profileId"),
    };
    try {
      const payload =
        request.method === "POST"
          ? { ...scope, command: await readJson(request, { maxBytes: 524_288 }) }
          : {
              ...scope,
              policyId: requestUrl.searchParams.get("policyId"),
              afterId: requestUrl.searchParams.get("afterId"),
            };
      const result = await deps.trainingPayload(
        hostedLearning[2] === "/review"
          ? "hosted_model_learning_review"
          : request.method === "POST"
            ? "hosted_model_learning_command"
            : hostedLearning[2]
              ? "hosted_model_learning_sources"
              : "hosted_model_learning",
        payload,
        requestUrl,
      );
      response.setHeader("Cache-Control", "no-store");
      sendJson(response, 200, result);
    } catch (error) {
      if (error instanceof OpenPondLearningError || error instanceof OpenPondModelProjectApiError)
        sendJson(response, error.status, { code: error.code, error: error.message });
      else if (error instanceof ZodError)
        sendJson(response, 400, {
          code: "model_learning_request_invalid",
          error: "Learning request does not match its contract.",
        });
      else throw error;
    }
    return true;
  }
  const hostedRun =
    /^\/v1\/training\/models\/([^/]+)\/hosted-evaluations(?:\/([^/]+)(?:\/(result|cancel))?)?$/.exec(
      requestUrl.pathname,
    );
  if (
    hostedRun &&
    ((request.method === "GET" && hostedRun[3] !== "cancel") ||
      (request.method === "POST" && hostedRun[3] === "cancel"))
  ) {
    const action =
      hostedRun[3] === "cancel"
        ? "cancel_hosted_taskset_run"
        : hostedRun[3] === "result"
          ? "hosted_taskset_run_result"
          : hostedRun[2]
            ? "hosted_taskset_run"
            : "hosted_taskset_runs";
    const payload = {
      modelId: decodeURIComponent(hostedRun[1]!),
      runId: hostedRun[2] ? decodeURIComponent(hostedRun[2]) : undefined,
      profileId: requestUrl.searchParams.get("profileId"),
      afterId: requestUrl.searchParams.get("afterId"),
    };
    sendJson(response, 200, await deps.trainingPayload(action, payload, requestUrl));
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/v1/training/catalog") {
    sendJson(response, 200, await deps.trainingPayload("portable_catalog", {}, requestUrl));
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/v1/training/hosted-model-projects") {
    sendJson(
      response,
      200,
      await deps.trainingPayload(
        "hosted_model_projects",
        {
          profileId: requestUrl.searchParams.get("profileId"),
          refresh: requestUrl.searchParams.get("refresh") === "true",
        },
        requestUrl,
      ),
    );
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/v1/training/datasets") {
    sendJson(response, 200, await deps.trainingPayload("dataset_catalog", {}, requestUrl));
    return true;
  }
  const downloadMatch = /^\/v1\/training\/artifacts\/([^/]+)\/download$/.exec(requestUrl.pathname);
  if (request.method === "GET" && downloadMatch) {
    const result = (await deps.trainingPayload(
      "artifact_download",
      { artifactId: decodeURIComponent(downloadMatch[1]!) },
      requestUrl,
    )) as { artifact: { path: string; sizeBytes: number }; path: string };
    const info = await stat(result.path);
    if (!info.isFile() || info.size !== result.artifact.sizeBytes)
      throw new Error("Training artifact changed before download.");
    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(info.size),
      "Content-Disposition": `attachment; filename="${path.basename(result.path).replaceAll('"', "")}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    createReadStream(result.path).pipe(response);
    return true;
  }
  const modelDownloadMatch = /^\/v1\/training\/models\/([^/]+)\/download$/.exec(
    requestUrl.pathname,
  );
  if (request.method === "GET" && modelDownloadMatch) {
    const result = (await deps.trainingPayload(
      "model_package_download",
      { modelId: decodeURIComponent(modelDownloadMatch[1]!) },
      requestUrl,
    )) as TrainingArtifactPackage;
    response.writeHead(200, {
      "Content-Type": "application/x-tar",
      "Content-Length": String(trainingArtifactPackageSize(result)),
      "Content-Disposition": `attachment; filename="${result.filename.replaceAll('"', "")}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    await streamTrainingArtifactPackage(response, result);
    return true;
  }
  const bundleDownloadMatch = /^\/v1\/training\/bundles\/([^/]+)\/download$/.exec(
    requestUrl.pathname,
  );
  if (request.method === "GET" && bundleDownloadMatch) {
    const result = (await deps.trainingPayload(
      "export_bundle",
      { bundleId: decodeURIComponent(bundleDownloadMatch[1]!) },
      requestUrl,
    )) as { filename: string; content: string };
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="${result.filename.replaceAll('"', "")}"`,
    );
    sendBinary(
      response,
      200,
      Buffer.from(result.content, "utf8"),
      "application/vnd.openpond.training-bundle+json",
    );
    return true;
  }
  if (
    request.method === "GET" &&
    ["/v1/training/tasks", "/v1/training/tasks/detail"].includes(requestUrl.pathname)
  ) {
    sendJson(
      response,
      200,
      await deps.trainingPayload(
        requestUrl.pathname.endsWith("/detail") ? "task_inventory_detail" : "task_inventory",
        {},
        requestUrl,
      ),
    );
    return true;
  }
  const route = routes.find(
    (item) => item.method === request.method && item.path === requestUrl.pathname,
  );
  if (route) {
    sendJson(
      response,
      route.status ?? 200,
      await deps.trainingPayload(route.action, await readJson(request), requestUrl),
    );
    return true;
  }
  for (const item of dynamic) {
    const match = item.pattern.exec(requestUrl.pathname);
    if (!match || request.method !== item.method) continue;
    const body =
      request.method === "GET" || request.method === "DELETE" ? {} : await readJson(request);
    const payload = {
      ...(item.wrap ? { [item.wrap]: body } : record(body)),
      [item.key]: decodeURIComponent(match[1]!),
      ...(item.assignmentKey ? { [item.assignmentKey]: decodeURIComponent(match[2]!) } : {}),
      ...(item.action === "model_comparison_attempt_evidence"
        ? { kind: requestUrl.searchParams.get("kind") }
        : {}),
      ...(item.action === "managed_candidate_review"
        ? { refresh: requestUrl.searchParams.get("refresh") === "true" }
        : {}),
      ...(item.action === "managed_candidate_review_history"
        ? {
            decisionId: requestUrl.searchParams.get("decisionId"),
            decisionHash: requestUrl.searchParams.get("decisionHash"),
          }
        : {}),
      ...(item.action === "run_detail"
        ? {
            includeEvaluation: requestUrl.searchParams.get("evaluation") !== "false",
            refresh: requestUrl.searchParams.get("refresh") !== "false",
          }
        : {}),
      ...(item.action === "managed_evaluation_tasks"
        ? {
            cursor: requestUrl.searchParams.get("cursor") ?? undefined,
            limit: requestUrl.searchParams.has("limit")
              ? Number(requestUrl.searchParams.get("limit"))
              : undefined,
          }
        : {}),
    };
    const controller = new AbortController();
    request.once("aborted", () => controller.abort(new Error("training_request_aborted")));
    response.once("close", () => {
      if (!response.writableEnded) controller.abort(new Error("training_response_closed"));
    });
    sendJson(
      response,
      200,
      await deps.trainingPayload(item.action, payload, requestUrl, controller.signal),
    );
    return true;
  }
  return false;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
