import { z } from "zod";
import { contentHash } from "@openpond/harness";
import {
  DatasetPreparationCandidateSchema,
  DatasetPreparationCommandSchema,
  DatasetPreparationCreateSchema,
  DatasetPreparationListSchema,
  DatasetPreparationRunSchema,
  DatasetPreparationGrantCreateSchema,
  DatasetPreparationGrantSchema,
} from "./dataset-preparation-contracts.js";

const Id = z.string().trim().min(1).max(240);
const CandidatePage = z
  .object({
    teamId: Id,
    datasetId: Id,
    runId: Id,
    candidates: z.array(DatasetPreparationCandidateSchema).max(50),
    nextCursor: Id.nullable(),
  })
  .strict();

export class DatasetPreparationRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DatasetPreparationRequestError";
  }
}

/** The same durable run is controlled by web, Desktop and CLI. A timed-out
 * write is recovered by operation ID, never replaced with a new paid intent. */
export class OpenPondDatasetPreparationClient {
  private readonly baseUrl: string;
  constructor(
    private readonly options: {
      baseUrl: string;
      apiKey: string;
      teamId: string;
      fetch?: typeof fetch;
    },
  ) {
    const url = new URL(options.baseUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !options.apiKey.trim() ||
      !options.teamId.trim()
    )
      throw new Error(
        "A clean API origin and workspace credentials are required.",
      );
    this.baseUrl = url.toString().replace(/\/+$/, "");
  }

  async create(
    datasetId: string,
    input: z.input<typeof DatasetPreparationCreateSchema>,
    signal?: AbortSignal,
  ) {
    const request = DatasetPreparationCreateSchema.parse(input);
    const result = this.readRun(
      await this.request(datasetId, "", "POST", request, signal),
      datasetId,
    );
    if (
      result.operationId !== request.operationId ||
      result.requestHash !== contentHash(request) ||
      result.datasetRevision !== request.expectedDatasetRevision
    )
      throw new Error(
        "Preparation creation receipt differs from the saved intent.",
      );
    return result;
  }

  async createGrant(
    datasetId: string,
    input: z.input<typeof DatasetPreparationGrantCreateSchema>,
    signal?: AbortSignal,
  ) {
    const request = DatasetPreparationGrantCreateSchema.parse(input);
    const grant = this.readGrant(
      await this.request(datasetId, "/grants", "POST", request, signal),
    );
    if (
      grant.id !== request.id ||
      grant.projectId !== request.projectId ||
      grant.maximumMicroUsd !== request.maximumMicroUsd ||
      grant.maximumSandboxSeconds !== request.maximumSandboxSeconds
    )
      throw new Error(
        "Preparation grant receipt differs from the saved limits.",
      );
    return grant;
  }

  async getGrant(datasetId: string, grantId: string, signal?: AbortSignal) {
    const grant = this.readGrant(
      await this.request(
        datasetId,
        `/grants/${encodeURIComponent(Id.parse(grantId))}`,
        "GET",
        undefined,
        signal,
      ),
    );
    if (grant.id !== grantId)
      throw new Error("Preparation grant identity mismatch.");
    return grant;
  }

  private readGrant(value: unknown) {
    const grant = DatasetPreparationGrantSchema.parse(value);
    if (grant.teamId !== this.options.teamId)
      throw new Error("Preparation grant workspace mismatch.");
    return grant;
  }

  async get(datasetId: string, runId: string, signal?: AbortSignal) {
    return this.readRun(
      await this.request(
        datasetId,
        `/${encodeURIComponent(Id.parse(runId))}`,
        "GET",
        undefined,
        signal,
      ),
      datasetId,
      runId,
    );
  }

  async list(
    datasetId: string,
    options: { cursor?: string; signal?: AbortSignal } = {},
  ) {
    const query = new URLSearchParams(
      options.cursor ? { cursor: Id.parse(options.cursor) } : {},
    );
    const result = DatasetPreparationListSchema.parse(
      await this.request(
        datasetId,
        `?${query}`,
        "GET",
        undefined,
        options.signal,
      ),
    );
    if (
      result.teamId !== this.options.teamId ||
      result.datasetId !== datasetId ||
      result.runs.some(
        (run) => run.teamId !== result.teamId || run.datasetId !== datasetId,
      ) ||
      new Set(result.runs.map((run) => run.id)).size !== result.runs.length
    )
      throw new Error("Preparation list scope/identity mismatch.");
    return result;
  }

  async command(
    datasetId: string,
    runId: string,
    input: z.input<typeof DatasetPreparationCommandSchema>,
    signal?: AbortSignal,
  ) {
    const request = DatasetPreparationCommandSchema.parse(input);
    const result = this.readRun(
      await this.request(
        datasetId,
        `/${encodeURIComponent(Id.parse(runId))}/commands`,
        "POST",
        request,
        signal,
      ),
      datasetId,
      runId,
    );
    if (result.revision < request.expectedRevision + 1)
      throw new Error(
        "Preparation command did not advance the expected revision.",
      );
    return result;
  }

  async operationResult(
    datasetId: string,
    operationId: string,
    signal?: AbortSignal,
  ) {
    const result = await this.request(
      datasetId,
      `/operations/${encodeURIComponent(Id.parse(operationId))}`,
      "GET",
      undefined,
      signal,
    );
    if (result === null) return null;
    const receipt = z
      .object({
        operationId: Id,
        requestHash: z.string().regex(/^[a-f0-9]{64}$/),
        run: DatasetPreparationRunSchema,
      })
      .strict()
      .parse(result);
    if (receipt.operationId !== operationId)
      throw new Error("Preparation operation recovery identity mismatch.");
    this.readRun(receipt.run, datasetId);
    return receipt;
  }

  async candidates(
    datasetId: string,
    runId: string,
    options: { cursor?: string; signal?: AbortSignal } = {},
  ) {
    const query = new URLSearchParams(
      options.cursor ? { cursor: Id.parse(options.cursor) } : {},
    );
    const result = CandidatePage.parse(
      await this.request(
        datasetId,
        `/${encodeURIComponent(Id.parse(runId))}/candidates?${query}`,
        "GET",
        undefined,
        options.signal,
      ),
    );
    if (
      result.teamId !== this.options.teamId ||
      result.datasetId !== datasetId ||
      result.runId !== runId ||
      result.candidates.some((candidate) => candidate.runId !== runId) ||
      new Set(result.candidates.map((candidate) => candidate.id)).size !==
        result.candidates.length
    )
      throw new Error("Preparation candidate page scope/identity mismatch.");
    return result;
  }

  private readRun(value: unknown, datasetId: string, runId?: string) {
    const result = DatasetPreparationRunSchema.parse(value);
    if (
      result.teamId !== this.options.teamId ||
      result.datasetId !== datasetId ||
      (runId && result.id !== runId)
    )
      throw new Error("Preparation run scope/identity mismatch.");
    return result;
  }

  private async request(
    datasetId: string,
    path: string,
    method: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await (this.options.fetch ?? fetch)(
      `${this.baseUrl}/v1/dataset-workspaces/${encodeURIComponent(Id.parse(datasetId))}/preparations${path}`,
      {
        method,
        signal,
        redirect: "error",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "X-OpenPond-Team-Id": this.options.teamId,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    if (!response.body) {
      if (!response.ok)
        throw new DatasetPreparationRequestError(
          response.status,
          "dataset_preparation_request_failed",
          `Dataset preparation request failed (${response.status}).`,
        );
      throw new Error("Preparation response is empty.");
    }
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > (response.ok ? 8 * 1024 * 1024 : 64 * 1024))
          throw new Error("Preparation response exceeds its bounded page.");
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!response.ok) {
      let value: unknown = null;
      try {
        value = JSON.parse(raw);
      } catch {
        /* Gateways can return non-JSON failures. */
      }
      const error = z
        .object({ code: z.string().max(240), message: z.string().max(5_000) })
        .safeParse(value);
      throw new DatasetPreparationRequestError(
        response.status,
        error.success ? error.data.code : "dataset_preparation_request_failed",
        error.success
          ? error.data.message
          : `Dataset preparation request failed (${response.status}).`,
      );
    }
    return JSON.parse(raw);
  }
}
