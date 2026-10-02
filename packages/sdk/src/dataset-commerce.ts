import { z } from "zod";
import {
  CaptureCommerceRelease,
  CommerceBrowse,
  CommerceCheckout,
  CommerceId,
  CommerceOperation,
  ReviewDatasetOffer,
  SubmitDatasetOffer,
  WriteDatasetRequest,
  WriteCommerceListing,
} from "./dataset-commerce-contracts.js";
import {
  CommerceCapturedReleaseSchema,
  CommerceInventorySchema,
  CommerceListingReceiptSchema,
  CommerceListingSchema,
  CommerceListingsPageSchema,
  CommerceOrderSchema,
  CommercePaymentSubmissionSchema,
  CommerceRequestSchema,
  CommerceRequestsPageSchema,
  CommerceRequestReceiptSchema,
  CommerceOwnedRequestSchema,
  CommerceOfferSchema,
  CommerceOfferSubmissionSchema,
  CommerceOfferReviewReceiptSchema,
} from "./dataset-commerce-responses.js";
export * from "./dataset-commerce-contracts.js";
export * from "./dataset-commerce-responses.js";

export interface DatasetCommerceClientOptions {
  baseUrl: string;
  apiKey?: string;
  teamId?: string;
  fetch?: typeof globalThis.fetch;
}
type RequestOptions = { signal?: AbortSignal };
export class OpenPondDatasetCommerceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OpenPondDatasetCommerceError";
  }
}
/** Retained dataset commerce. Checkout creates a quote only: this client never signs or sends wallet transactions. */
export class OpenPondDatasetCommerceClient {
  readonly #options: DatasetCommerceClientOptions;
  constructor(options: DatasetCommerceClientOptions) {
    const url = new URL(options.baseUrl);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        "Dataset commerce base URL must be an HTTP(S) endpoint without credentials, query, or fragment.",
      );
    this.#options = { ...options, baseUrl: url.toString().replace(/\/+$/, "") };
  }
  async browse(query: z.input<typeof CommerceBrowse> = {}, options: RequestOptions = {}) {
    const input = CommerceBrowse.parse(query),
      search = new URLSearchParams();
    for (const [key, value] of Object.entries(input))
      if (value !== undefined) search.set(key, String(value));
    const result = CommerceListingsPageSchema.parse(
      await this.#request(`/listings?${search}`, options),
    );
    if (
      result.items.length > input.limit ||
      result.items.some(
        (item) =>
          item.state !== "listed" || (input.category && item.terms.category !== input.category),
      )
    )
      this.#mismatch();
    return result;
  }
  async listing(id: string, options: RequestOptions = {}) {
    CommerceId.parse(id);
    const result = CommerceListingSchema.parse(
      await this.#request(`/listings/${encodeURIComponent(id)}`, options),
    );
    if (result.id !== id) this.#mismatch();
    return result;
  }
  async inventory(options: RequestOptions = {}) {
    const result = CommerceInventorySchema.parse(
      await this.#request("/inventory", options, undefined, true),
    );
    if (result.listings.some((item) => item.teamId !== this.#options.teamId)) this.#mismatch();
    return result;
  }
  async capture(input: z.infer<typeof CaptureCommerceRelease>, options: RequestOptions = {}) {
    const request = CaptureCommerceRelease.parse(input);
    const result = CommerceCapturedReleaseSchema.parse(
      await this.#request("/capture", options, request),
    );
    if (
      result.packageHash !== request.packageHash ||
      result.release.id !== request.release.id ||
      result.release.revision !== request.release.revision ||
      result.release.contentHash !== request.release.contentHash ||
      result.sample.length !== new Set(request.sampleTaskIds).size ||
      result.sample.some((item) => !request.sampleTaskIds.includes(item.taskId))
    )
      this.#mismatch();
    return result;
  }
  async writeListing(input: z.infer<typeof WriteCommerceListing>, options: RequestOptions = {}) {
    const request = WriteCommerceListing.parse(input);
    const result = CommerceListingReceiptSchema.parse(
      await this.#request("/write-listing", options, request),
    );
    if (
      (request.id && result.id !== request.id) ||
      result.revision !== request.expectedRevision + 1 ||
      result.releaseId !== request.releaseId ||
      result.state !== request.state ||
      JSON.stringify(result.terms) !== JSON.stringify(request.terms)
    )
      this.#mismatch();
    return result;
  }
  async checkout(input: z.infer<typeof CommerceCheckout>, options: RequestOptions = {}) {
    const request = CommerceCheckout.parse(input);
    const result = CommerceOrderSchema.parse(await this.#request("/checkout", options, request));
    if (
      result.buyerTeamId !== this.#options.teamId ||
      result.source !== request.source ||
      result.sourceId !== request.sourceId ||
      result.sourceRevision !== request.sourceRevision ||
      result.termsHash !== request.acceptedTermsHash ||
      result.destinationProjectId !== request.destinationProjectId
    )
      this.#mismatch();
    return result;
  }
  async order(id: string, options: RequestOptions = {}) {
    CommerceId.parse(id);
    const result = CommerceOrderSchema.parse(
      await this.#request(`/order/${encodeURIComponent(id)}`, options, undefined, true),
    );
    if (
      result.id !== id ||
      (result.buyerTeamId !== this.#options.teamId && result.sellerTeamId !== this.#options.teamId)
    )
      this.#mismatch();
    return result;
  }
  async purchases(options: RequestOptions = {}) {
    return this.#orders("purchases", options);
  }
  async sales(options: RequestOptions = {}) {
    return this.#orders("sales", options);
  }
  async submitPayment(
    input: { operationId: string; orderId: string; transactionHash: string },
    options: RequestOptions = {},
  ) {
    const request = CommerceOperation.extend({
      orderId: CommerceId,
      transactionHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
    })
      .strict()
      .parse(input);
    const result = CommercePaymentSubmissionSchema.parse(
      await this.#request("/submit-payment", options, request),
    );
    if (("orderId" in result ? result.orderId : result.id) !== request.orderId) this.#mismatch();
    return result;
  }
  async requests(query: z.input<typeof CommerceBrowse> = {}, options: RequestOptions = {}) {
    const input = CommerceBrowse.parse(query),
      search = new URLSearchParams();
    for (const [key, value] of Object.entries(input))
      if (value !== undefined) search.set(key, String(value));
    const result = CommerceRequestsPageSchema.parse(
      await this.#request(`/requests?${search}`, options),
    );
    if (
      result.items.length > input.limit ||
      result.items.some((item) => item.state !== "open" || item.content.projectId !== null)
    )
      this.#mismatch();
    return result;
  }
  async request(id: string, options: RequestOptions = {}) {
    CommerceId.parse(id);
    const result = CommerceRequestSchema.parse(
      await this.#request(`/requests/${encodeURIComponent(id)}`, options),
    );
    if (result.id !== id || result.content.projectId !== null) this.#mismatch();
    return result;
  }
  async myRequests(options: RequestOptions = {}) {
    const result = z
      .array(CommerceOwnedRequestSchema)
      .max(100)
      .parse(await this.#request("/my-requests", options, undefined, true));
    if (result.some((item) => item.teamId !== this.#options.teamId)) this.#mismatch();
    return result;
  }
  async writeRequest(input: z.infer<typeof WriteDatasetRequest>, options: RequestOptions = {}) {
    const request = WriteDatasetRequest.parse(input),
      result = CommerceRequestReceiptSchema.parse(
        await this.#request("/write-request", options, request),
      );
    if (
      (request.id && result.id !== request.id) ||
      result.revision !== request.expectedRevision + 1 ||
      result.state !== request.state ||
      JSON.stringify(result.content) !== JSON.stringify(request.content)
    )
      this.#mismatch();
    return result;
  }
  async submitOffer(input: z.infer<typeof SubmitDatasetOffer>, options: RequestOptions = {}) {
    const request = SubmitDatasetOffer.parse(input),
      result = CommerceOfferSubmissionSchema.parse(
        await this.#request("/submit-offer", options, request),
      );
    if (result.revision !== request.expectedRevision + 1) this.#mismatch();
    return result;
  }
  async offers(direction: "sent" | "received", options: RequestOptions = {}) {
    z.enum(["sent", "received"]).parse(direction);
    const result = z
      .array(CommerceOfferSchema)
      .max(100)
      .parse(await this.#request(`/${direction}-offers`, options, undefined, true));
    if (
      result.some(
        (item) =>
          item.proposal.offerId !== item.id ||
          item.proposal.revision !== item.revision ||
          (direction === "sent" && item.notes.length),
      )
    )
      this.#mismatch();
    return result;
  }
  async reviewOffer(input: z.infer<typeof ReviewDatasetOffer>, options: RequestOptions = {}) {
    const request = ReviewDatasetOffer.parse(input),
      result = CommerceOfferReviewReceiptSchema.parse(
        await this.#request("/review-offer", options, request),
      );
    if (
      result.id !== request.id ||
      result.revision !== request.expectedRevision ||
      result.state !== request.state
    )
      this.#mismatch();
    return result;
  }
  async withdrawOffer(
    input: { operationId: string; id: string; expectedRevision: number; expectedUpdatedAt: string },
    options: RequestOptions = {},
  ) {
    const request = CommerceOperation.extend({
      id: CommerceId,
      expectedRevision: z.number().int().positive(),
      expectedUpdatedAt: z.string().datetime(),
    })
      .strict()
      .parse(input);
    const result = z
      .object({ id: CommerceId, state: z.literal("withdrawn") })
      .strict()
      .parse(await this.#request("/withdraw-offer", options, request));
    if (result.id !== request.id) this.#mismatch();
    return result;
  }
  async #orders(side: "purchases" | "sales", options: RequestOptions) {
    const result = z
      .array(CommerceOrderSchema)
      .max(100)
      .parse(await this.#request(`/${side}`, options, undefined, true));
    if (
      result.some(
        (item) =>
          (side === "purchases" ? item.buyerTeamId : item.sellerTeamId) !== this.#options.teamId,
      )
    )
      this.#mismatch();
    return result;
  }
  #mismatch(): never {
    throw new OpenPondDatasetCommerceError(
      502,
      "dataset_commerce_identity_mismatch",
      "Dataset commerce response did not match the requested release, terms, or workspace.",
    );
  }
  async #request(
    path: string,
    options: RequestOptions,
    body?: unknown,
    authenticated = false,
  ): Promise<unknown> {
    const auth = authenticated || body !== undefined;
    if (auth && (!this.#options.apiKey?.trim() || !this.#options.teamId?.trim()))
      throw new Error(
        "An API key and explicit workspace are required for this dataset commerce operation.",
      );
    const response = await (this.#options.fetch ?? globalThis.fetch)(
      `${this.#options.baseUrl}/v1/dataset-commerce${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        signal: options.signal,
        redirect: "error",
        headers: {
          Accept: "application/json",
          ...(auth
            ? {
                Authorization: `Bearer ${this.#options.apiKey}`,
                "X-OpenPond-Team-Id": this.#options.teamId!,
              }
            : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    const reader = response.body?.getReader();
    if (!reader)
      throw new OpenPondDatasetCommerceError(
        response.status,
        "empty_response",
        "Dataset commerce response was empty.",
      );
    const decoder = new TextDecoder();
    let bytes = 0,
      text = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 4_194_304)
          throw new OpenPondDatasetCommerceError(
            response.status,
            "response_too_large",
            "Dataset commerce response exceeded 4 MiB.",
          );
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new OpenPondDatasetCommerceError(
        response.status,
        "invalid_response",
        "Dataset commerce response was not valid JSON.",
      );
    }
    if (!response.ok) {
      const error = z
        .object({ code: z.string().min(1), message: z.string().min(1) })
        .safeParse(payload);
      throw new OpenPondDatasetCommerceError(
        response.status,
        error.success ? error.data.code : "invalid_error_response",
        error.success
          ? error.data.message
          : `Dataset commerce request failed (${response.status}).`,
      );
    }
    return payload;
  }
}
