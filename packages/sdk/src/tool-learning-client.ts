import { z } from "zod";
import { contentHash } from "@openpond/harness";
import { LearningRevisionRefSchema } from "@openpond/evals/learning";
import {
  TOOL_LEARNING_LIMITS,
  ToolLearningRegistrationSchema,
  ToolLearningInstallationSchema,
  ToolLearningIdSchema,
  ToolLearningRefSchema,
  ToolLearningDecisionSchema,
  boundedToolLearningSchema,
  ToolLearningInstallationUpdateSchema,
  ToolEpisodeAppendSchema,
  ToolEpisodeAppendReceiptSchema,
  ToolLearningManifestSchema,
  ToolLearningCapabilitySchema,
  ToolLearningConsultationRequestSchema,
  assertToolLearningConsultationResponse,
  type ToolLearningRegistration,
  type ToolEpisodeAppend,
  type ToolLearningConsultationRequest,
} from "@openpond/evals/tool-learning";
import {
  LearningSourceCredentialSecretSchema,
  createSourceCredentialRequest,
} from "./learning-credentials.js";
import { assertBoundedTaskJson } from "@openpond/evals/task-schema";
import { readBoundedJsonResponse } from "./protocol.js";
import { assembleToolLearningEpisode } from "./tool-learning-episodes.js";
import {
  ToolLearningRegistrationReceiptSchema,
  ToolLearningInstallationPageSchema,
  ToolLearningEpisodePageSchema,
  ToolLearningEpisodeDetailSchema,
  ToolLearningPurgeRequestSchema,
  ToolLearningPurgeReceiptSchema,
} from "./tool-learning-responses.js";

/** Prepare and retain this request privately before registration. Retrying the
 * same bytes recovers issuance without storing plaintext on the host. */
export const ToolLearningRegistrationRequestSchema = boundedToolLearningSchema(
  z
    .object({
      registration: ToolLearningRegistrationSchema,
      credential: z
        .object({ apiKey: LearningSourceCredentialSecretSchema, expiresAt: z.iso.datetime() })
        .strict(),
    })
    .strict(),
  TOOL_LEARNING_LIMITS.eventBytes,
);

export const ToolLearningProjectionRequestSchema = boundedToolLearningSchema(
  z
    .object({
      operationId: ToolLearningIdSchema,
      expectedRevision: z.number().int().positive(),
      episodeId: ToolLearningIdSchema,
      failure: ToolLearningRefSchema,
      recovery: ToolLearningRefSchema,
      taskDefinition: LearningRevisionRefSchema,
      familyKey: ToolLearningIdSchema,
      split: z.literal("train"),
      proposedTarget: ToolLearningDecisionSchema,
      saveToPrivateDataset: z.literal(true),
      targetApproval: z.literal("pending_owner_review"),
    })
    .strict(),
  TOOL_LEARNING_LIMITS.eventBytes,
);
export const ToolLearningProjectionReceiptSchema = boundedToolLearningSchema(
  z
    .object({
      installationId: ToolLearningIdSchema,
      projectId: ToolLearningIdSchema,
      operationId: ToolLearningIdSchema,
      source: LearningRevisionRefSchema,
      evidence: LearningRevisionRefSchema,
      originHash: z.string().regex(/^[a-f0-9]{64}$/),
      requestHash: z.string().regex(/^[a-f0-9]{64}$/),
      projectedAt: z.iso.datetime(),
      targetApproval: z.literal("pending_owner_review"),
      learningEnrollment: z.literal(false),
    })
    .strict(),
  TOOL_LEARNING_LIMITS.eventBytes,
);

/** Explicit owner selection. Capturing events never authorizes inference spend. */
export const ToolLearningRoutingRequestSchema = boundedToolLearningSchema(
  z
    .object({
      operationId: ToolLearningIdSchema,
      expectedRevision: z.number().int().nonnegative(),
      state: z.enum(["enabled", "disabled"]),
      modelId: ToolLearningIdSchema,
      qualification: z.discriminatedUnion("kind", [
        z
          .object({ kind: z.literal("integration"), evaluationRunId: ToolLearningIdSchema })
          .strict(),
        z
          .object({
            kind: z.literal("learned"),
            evaluationRunId: ToolLearningIdSchema,
            baselineRunId: ToolLearningIdSchema,
            trainingRunId: ToolLearningIdSchema,
          })
          .strict(),
      ]),
      capabilities: z
        .array(ToolLearningCapabilitySchema.omit({ qualification: true }))
        .min(1)
        .max(16),
      limits: z
        .object({
          maxOutputTokens: z.number().int().min(128).max(2048),
          maximumCallUsd: z.number().positive().max(1),
          maximumDayUsd: z.number().positive().max(10),
          maximumSessionCalls: z.number().int().min(1).max(20),
          maximumDayCalls: z.number().int().min(1).max(200),
        })
        .strict(),
    })
    .strict(),
  TOOL_LEARNING_LIMITS.eventBytes,
);
export const ToolLearningRoutingSchema = boundedToolLearningSchema(
  z
    .object({
      installationId: ToolLearningIdSchema,
      scope: z.object({ teamId: ToolLearningIdSchema, projectId: ToolLearningIdSchema }).strict(),
      revision: z.number().int().positive(),
      operationId: ToolLearningIdSchema,
      requestHash: z.string().regex(/^[a-f0-9]{64}$/),
      configuration: ToolLearningRoutingRequestSchema,
      modelRelease: ToolLearningRefSchema,
      policySystemPrompt: z.string().min(1).max(16384),
      capabilities: z.array(ToolLearningCapabilitySchema).max(16),
      updatedAt: z.iso.datetime(),
    })
    .strict(),
  TOOL_LEARNING_LIMITS.eventBytes,
);

export function prepareToolLearningRegistration(
  registration: ToolLearningRegistration,
  expiresAt: string,
) {
  const prepared = createSourceCredentialRequest({
    sourceId: registration.installationId,
    name: "Tool learning installation",
    expiresAt,
  });
  return ToolLearningRegistrationRequestSchema.parse({
    registration,
    credential: { apiKey: prepared.apiKey, expiresAt },
  });
}

export class OpenPondToolLearningError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Tool learning request failed (${status}): ${code}`);
    this.name = "OpenPondToolLearningError";
  }
}

/** Owner credentials register/control installations. External hooks and MCP
 * use only the separate installation credential returned by registration. */
type ToolLearningClientOptions = {
  baseUrl: string;
  apiKey: string;
  teamId: string;
  projectId: string;
  fetch?: typeof globalThis.fetch;
};

export class OpenPondToolLearningClient {
  readonly #baseUrl: string;
  readonly #options: ToolLearningClientOptions;
  constructor(options: ToolLearningClientOptions) {
    this.#options = { ...options };

    const url = new URL(options.baseUrl);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !options.apiKey.trim() ||
      !options.teamId.trim() ||
      !options.projectId.trim()
    )
      throw new Error("tool_learning_client_scope_required");
    this.#baseUrl = url.toString().replace(/\/+$/, "");
  }

  async register(
    value: z.input<typeof ToolLearningRegistrationRequestSchema>,
    signal?: AbortSignal,
  ) {
    const input = ToolLearningRegistrationRequestSchema.parse(value);
    if (input.registration.projectId !== this.#options.projectId)
      throw new Error("tool_learning_project_mismatch");
    const result = ToolLearningRegistrationReceiptSchema.parse(
      await this.#request("installations", "POST", input, signal),
    );
    this.#installation(result.installation, input.registration.installationId);
    if (result.apiKey !== input.credential.apiKey)
      throw new Error("tool_learning_credential_mismatch");
    const installation = result.installation;
    if (
      installation.client !== input.registration.client ||
      installation.clientVersion !== input.registration.clientVersion ||
      installation.machineSourceId !== input.registration.machineSourceId ||
      contentHash(installation.adapterRelease) !== contentHash(input.registration.adapterRelease) ||
      contentHash(installation.collectionPolicy) !==
        contentHash(input.registration.collectionPolicy) ||
      installation.collectionPolicyHash !== contentHash(input.registration.collectionPolicy) ||
      installation.credential?.expiresAt !== input.credential.expiresAt
    )
      throw new Error("tool_learning_registration_receipt_mismatch");
    return result;
  }

  async installation(id: string, signal?: AbortSignal) {
    const result = ToolLearningInstallationSchema.parse(
      await this.#request(`installations/${encodeURIComponent(id)}`, "GET", undefined, signal),
    );
    this.#installation(result, id);
    return result;
  }

  async installations(after?: string, signal?: AbortSignal) {
    const result = ToolLearningInstallationPageSchema.parse(
      await this.#request(
        `installations?projectId=${encodeURIComponent(this.#options.projectId)}${after ? `&after=${encodeURIComponent(after)}` : ""}`,
        "GET",
        undefined,
        signal,
      ),
    );
    for (const installation of result.items) this.#installation(installation, installation.id);
    if (result.nextCursor !== null && result.nextCursor !== result.items.at(-1)?.id)
      throw new Error("tool_learning_installation_cursor_mismatch");
    return result;
  }

  async episodes(installationId: string, after?: string, signal?: AbortSignal) {
    const result = ToolLearningEpisodePageSchema.parse(
      await this.#request(
        `installations/${encodeURIComponent(installationId)}/episodes${after ? `?after=${encodeURIComponent(after)}` : ""}`,
        "GET",
        undefined,
        signal,
      ),
    );
    if (
      result.installationId !== installationId ||
      result.scope.teamId !== this.#options.teamId ||
      result.scope.projectId !== this.#options.projectId ||
      (result.nextCursor !== null && result.nextCursor !== result.items.at(-1)?.episodeId)
    )
      throw new Error("tool_learning_episode_page_mismatch");
    return result;
  }

  async episode(installationId: string, episodeId: string, signal?: AbortSignal) {
    const result = ToolLearningEpisodeDetailSchema.parse(
      await this.#request(
        `installations/${encodeURIComponent(installationId)}/episodes/${encodeURIComponent(episodeId)}`,
        "GET",
        undefined,
        signal,
      ),
    );
    if (
      result.installationId !== installationId ||
      result.episodeId !== episodeId ||
      result.scope.teamId !== this.#options.teamId ||
      result.scope.projectId !== this.#options.projectId ||
      result.events.some(
        (event) => event.installationId !== installationId || event.episodeId !== episodeId,
      )
    )
      throw new Error("tool_learning_episode_scope_mismatch");
    if (
      result.state !== result.assembly.state ||
      contentHash(assembleToolLearningEpisode(result.events)) !== contentHash(result.assembly)
    )
      throw new Error("tool_learning_episode_assembly_mismatch");
    return result;
  }

  async purge(
    installationId: string,
    input: { operationId: string; expectedRevision: number },
    signal?: AbortSignal,
  ) {
    const request = ToolLearningPurgeRequestSchema.parse(input);
    const result = ToolLearningPurgeReceiptSchema.parse(
      await this.#request(
        `installations/${encodeURIComponent(installationId)}/purge`,
        "POST",
        request,
        signal,
      ),
    );
    if (result.installationId !== installationId || result.operationId !== request.operationId)
      throw new Error("tool_learning_purge_scope_mismatch");
    return result;
  }

  async project(
    installationId: string,
    value: z.input<typeof ToolLearningProjectionRequestSchema>,
    signal?: AbortSignal,
  ) {
    const input = ToolLearningProjectionRequestSchema.parse(value);
    const result = ToolLearningProjectionReceiptSchema.parse(
      await this.#request(
        `installations/${encodeURIComponent(installationId)}/project`,
        "POST",
        input,
        signal,
      ),
    );
    if (
      result.installationId !== installationId ||
      result.projectId !== this.#options.projectId ||
      result.operationId !== input.operationId ||
      result.requestHash !== contentHash(input)
    )
      throw new Error("tool_learning_projection_scope_mismatch");
    return result;
  }

  async setState(
    id: string,
    value: z.input<typeof ToolLearningInstallationUpdateSchema>,
    signal?: AbortSignal,
  ) {
    const input = ToolLearningInstallationUpdateSchema.parse(value);
    const result = ToolLearningInstallationSchema.parse(
      await this.#request(`installations/${encodeURIComponent(id)}`, "PATCH", input, signal),
    );
    this.#installation(result, id);
    if (result.state !== input.state) throw new Error("tool_learning_state_mismatch");
    return result;
  }

  async append(value: ToolEpisodeAppend, signal?: AbortSignal) {
    const input = ToolEpisodeAppendSchema.parse(value);
    const result = ToolEpisodeAppendReceiptSchema.parse(
      await this.#request("episodes", "POST", input, signal),
    );
    if (
      result.operationId !== input.operationId ||
      result.installationId !== input.installationId ||
      result.teamId !== this.#options.teamId ||
      result.projectId !== this.#options.projectId ||
      result.requestHash !== contentHash(input) ||
      result.events.length !== input.events.length ||
      new Set(result.events.map((event) => event.eventId)).size !== result.events.length
    )
      throw new Error("tool_learning_append_receipt_mismatch");
    for (const event of result.events) {
      const submitted = input.events.find((value) => value.eventId === event.eventId);
      if (!submitted || submitted.contentHash !== event.contentHash)
        throw new Error("tool_learning_append_event_mismatch");
    }
    return result;
  }

  async routing(installationId: string, signal?: AbortSignal) {
    return this.#routing(
      installationId,
      await this.#request(
        `installations/${encodeURIComponent(installationId)}/routing`,
        "GET",
        undefined,
        signal,
      ),
    );
  }

  async configureRouting(
    installationId: string,
    value: z.input<typeof ToolLearningRoutingRequestSchema>,
    signal?: AbortSignal,
  ) {
    const input = ToolLearningRoutingRequestSchema.parse(value);
    const result = this.#routing(
      installationId,
      await this.#request(
        `installations/${encodeURIComponent(installationId)}/routing`,
        "POST",
        input,
        signal,
      ),
    );
    if (
      result.operationId !== input.operationId ||
      result.requestHash !== contentHash(input) ||
      contentHash(result.configuration) !== contentHash(input)
    )
      throw new Error("tool_learning_routing_receipt_mismatch");
    return result;
  }

  #routing(installationId: string, value: unknown) {
    const result = ToolLearningRoutingSchema.parse(value);
    if (
      result.installationId !== installationId ||
      result.scope.teamId !== this.#options.teamId ||
      result.scope.projectId !== this.#options.projectId
    )
      throw new Error("tool_learning_routing_scope_mismatch");
    return result;
  }

  async manifest(installationId: string, signal?: AbortSignal) {
    const result = ToolLearningManifestSchema.parse(
      await this.#request(
        `installations/${encodeURIComponent(installationId)}/manifest`,
        "GET",
        undefined,
        signal,
      ),
    );
    if (
      result.installationId !== installationId ||
      result.scope.teamId !== this.#options.teamId ||
      result.scope.projectId !== this.#options.projectId
    )
      throw new Error("tool_learning_manifest_scope_mismatch");
    if (
      Date.parse(result.expiresAt) <= Date.now() ||
      Date.parse(result.issuedAt) > Date.now() + 30000
    )
      throw new Error("tool_learning_manifest_expired");
    return result;
  }

  async consult(value: ToolLearningConsultationRequest, signal?: AbortSignal) {
    const input = ToolLearningConsultationRequestSchema.parse(value);
    if (
      input.scope.teamId !== this.#options.teamId ||
      input.scope.projectId !== this.#options.projectId
    )
      throw new Error("tool_learning_consultation_scope_mismatch");
    return assertToolLearningConsultationResponse(
      input,
      await this.#request("consultations", "POST", input, signal),
    );
  }

  async consultation(value: ToolLearningConsultationRequest, signal?: AbortSignal) {
    const input = ToolLearningConsultationRequestSchema.parse(value);
    if (
      input.scope.teamId !== this.#options.teamId ||
      input.scope.projectId !== this.#options.projectId
    )
      throw new Error("tool_learning_consultation_scope_mismatch");
    return assertToolLearningConsultationResponse(
      input,
      await this.#request(
        `installations/${encodeURIComponent(input.installationId)}/consultations/${encodeURIComponent(input.operationId)}`,
        "GET",
        undefined,
        signal,
      ),
    );
  }

  #installation(value: z.infer<typeof ToolLearningInstallationSchema>, id: string) {
    if (
      value.id !== id ||
      value.scope.teamId !== this.#options.teamId ||
      value.scope.projectId !== this.#options.projectId
    )
      throw new Error("tool_learning_installation_scope_mismatch");
  }

  async #request(
    path: string,
    method: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (body !== undefined)
      assertBoundedTaskJson(
        body,
        TOOL_LEARNING_LIMITS.eventBytes * TOOL_LEARNING_LIMITS.eventsPerAppend,
      );
    const timeout = AbortSignal.timeout(30000);
    const response = await (this.#options.fetch ?? globalThis.fetch)(
      `${this.#baseUrl}/v1/tool-learning/${path}`,
      {
        method,
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: {
          Authorization: `Bearer ${this.#options.apiKey}`,
          "X-OpenPond-Team-Id": this.#options.teamId,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    const value = await readBoundedJsonResponse(
      response,
      TOOL_LEARNING_LIMITS.eventBytes * TOOL_LEARNING_LIMITS.eventsPerAppend,
      "Tool learning response",
    );
    if (!response.ok) {
      const error = z
        .object({
          code: z
            .string()
            .regex(/^[a-z0-9_]+$/)
            .max(200),
        })
        .passthrough()
        .safeParse(value);
      throw new OpenPondToolLearningError(
        response.status,
        error.success ? error.data.code : "tool_learning_request_failed",
      );
    }
    return value;
  }
}
