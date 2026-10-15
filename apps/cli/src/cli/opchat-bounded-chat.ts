import { createHash } from "node:crypto";
import { z } from "zod";
import { CodexReasoningEffortSchema } from "@openpond/contracts";
import { loadOpenPondAccountContext } from "@openpond/runtime";
import { CliReportedError } from "./common/reported-error";
import {
  getOpChatModel,
  resolveOpChatApiBaseUrl,
  sendHostedChatTurn,
  type HostedChatCompletion,
  type HostedChatUsage,
} from "../hosted-chat";
import {
  optionString,
  parseBooleanOption,
  resolveApiBaseUrlOption,
  resolveChatApiBaseUrlOption,
} from "./common";

const PositiveInteger = z.coerce.number().int().positive().safe();
const OptionsSchema = z.object({
  model: z.string().trim().min(1).max(512),
  message: z.string().trim().min(1).max(131_072),
  teamId: z.string().regex(/^[A-Za-z0-9_-]{3,191}$/),
  requestId: z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/),
  maxOutputTokens: PositiveInteger,
  timeoutSec: PositiveInteger.max(600),
  maxSpend: z.coerce.number().finite().positive(),
});
const Rate = z.number().finite().nonnegative();
const CatalogSchema = z.object({
  id: z.string(),
  context_window: PositiveInteger,
  output_limit: PositiveInteger,
  metadata: z.object({
    billing: z.object({
      pricing: z
        .object({
          version: z.string().trim().min(1),
          source: z.string().trim().min(1),
          effectiveAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
          inputUsdPerMillionTokens: Rate,
          cachedInputUsdPerMillionTokens: Rate,
          outputUsdPerMillionTokens: Rate,
        })
        .passthrough(),
    }),
  }),
});

type AccountLoader = (
  handle?: string | null,
) => Promise<
  Pick<Awaited<ReturnType<typeof loadOpenPondAccountContext>>, "token" | "chatApiBaseUrl">
>;
type Receipt = Record<string, unknown>;

/** One ordinary OpChat call. The catalog bounds its retail reservation;
 * physical capacity, provider invoices and post-cancel settlement stay separate. */
export async function runBoundedOpChat(
  options: Record<string, string | boolean>,
  dependencies: {
    account?: AccountLoader;
    emit?: (receipt: Receipt) => void;
  } = {},
): Promise<void> {
  const input = OptionsSchema.parse({
    ...options,
    message: optionString(options, "message") || optionString(options, "prompt"),
  });
  if (parseBooleanOption(options.stream))
    throw new Error("Bounded OpChat requires a non-streaming completion receipt; omit --stream.");
  const reasoningEffort =
    options.effort === undefined ? undefined : CodexReasoningEffortSchema.parse(options.effort);
  const emit = dependencies.emit ?? ((value) => console.log(JSON.stringify(value, null, 2)));
  const controller = new AbortController();
  const startedAt = new Date().toISOString();
  let dispatchAttempted = false;
  let quote: Receipt | null = null;
  let completion: HostedChatCompletion | null = null;
  let usage: HostedChatUsage | null = null;
  let text = "";
  let finishReason: string | null = null;
  let apiOrigin: string | null = null;
  const abort = (signal: string) => controller.abort(new Error(`OpChat cancelled by ${signal}.`));
  const interrupt = () => abort("SIGINT");
  const terminate = () => abort("SIGTERM");
  const timer = setTimeout(
    () => controller.abort(new DOMException("OpChat deadline reached.", "TimeoutError")),
    input.timeoutSec * 1_000,
  );
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  const receipt = (status: string, error?: string): Receipt => {
    const measuredUsage =
      usage &&
      usage.estimated !== true &&
      [
        usage.prompt_tokens ?? usage.input_tokens,
        usage.completion_tokens ?? usage.output_tokens,
      ].every((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
    return {
      schemaVersion: "openpond.boundedOpChatReceipt.v1",
      status,
      requestId: input.requestId,
      model: input.model,
      teamId: input.teamId,
      automaticRetry: false,
      startedAt,
      completedAt: new Date().toISOString(),
      apiOrigin,
      maxOutputTokens: input.maxOutputTokens,
      timeoutSec: input.timeoutSec,
      maximumSpendUsd: input.maxSpend,
      quote,
      dispatchAttempted,
      completion,
      usage,
      text,
      finishReason,
      accounting: {
        state: dispatchAttempted
          ? measuredUsage
            ? "usage_recorded"
            : "unknown"
          : "not_dispatched",
        chargedUsd: dispatchAttempted ? null : 0,
        requiresLedgerReconciliation: dispatchAttempted,
        cleanupConfirmed: !dispatchAttempted,
      },
      ...(error ? { error } : {}),
    };
  };
  try {
    const context = await (dependencies.account ?? loadOpenPondAccountContext)(
      optionString(options, "account"),
    );
    if (!context.token) throw new Error("Sign in to an OpenPond account before using OpChat.");
    const trusted = new URL(
      resolveOpChatApiBaseUrl({ opChatApiBaseUrl: context.chatApiBaseUrl, env: {} }),
    );
    const overrides = [
      optionString(options, "opchatApiBaseUrl"),
      optionString(options, "opchatApiUrl"),
      resolveChatApiBaseUrlOption(options),
      resolveApiBaseUrlOption(options),
    ].filter((value): value is string => Boolean(value));
    for (const override of overrides) {
      const url = new URL(override);
      if (url.origin !== trusted.origin || url.username || url.password || url.search || url.hash)
        throw new Error("The OpChat API URL must match the signed-in account's chat origin.");
    }
    if (trusted.username || trusted.password || trusted.search || trusted.hash)
      throw new Error("The signed-in account has an invalid OpChat URL.");
    const apiBaseUrl = resolveOpChatApiBaseUrl({
      opChatApiBaseUrl: overrides[0] ?? trusted.href,
      env: {},
    });
    apiOrigin = trusted.origin;
    controller.signal.throwIfAborted();
    const catalogRecord = await getOpChatModel({
      apiBaseUrl,
      token: context.token,
      teamId: input.teamId,
      model: input.model,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
    });
    const observedAt = new Date().toISOString();
    const catalog = CatalogSchema.parse(catalogRecord);
    if (catalog.id !== input.model)
      throw new Error("The catalog returned a different model identity.");
    if (input.maxOutputTokens > catalog.output_limit)
      throw new Error("The requested output limit exceeds the model's current limit.");
    const pricing = catalog.metadata.billing.pricing;
    const maximumMicroUsd = Math.ceil(
      catalog.context_window *
        Math.max(pricing.inputUsdPerMillionTokens, pricing.cachedInputUsdPerMillionTokens) +
        input.maxOutputTokens * pricing.outputUsdPerMillionTokens,
    );
    if (!Number.isSafeInteger(maximumMicroUsd) || maximumMicroUsd <= 0)
      throw new Error("The model does not publish an enforceable positive request ceiling.");
    const maximumRequestCostUsd = maximumMicroUsd / 1_000_000;
    quote = {
      kind: "worst_case_request_reservation",
      observedAt,
      contextWindow: catalog.context_window,
      outputLimit: catalog.output_limit,
      pricing,
      maximumRequestCostUsd,
      predictedSpend: false,
      catalog: catalogRecord,
      catalogSha256: createHash("sha256").update(JSON.stringify(catalogRecord)).digest("hex"),
    };
    if (maximumRequestCostUsd > input.maxSpend)
      throw new Error(
        `The current worst-case request reservation $${maximumRequestCostUsd} exceeds --max-spend $${input.maxSpend}.`,
      );
    controller.signal.throwIfAborted();
    const request = {
      apiBaseUrl,
      token: context.token,
      teamId: input.teamId,
      model: input.model,
      requestId: input.requestId,
      reasoningEffort,
      maxTokens: input.maxOutputTokens,
      signal: controller.signal,
      messages: [{ role: "user" as const, content: input.message }],
    };
    dispatchAttempted = true;
    completion = await sendHostedChatTurn(request);
    usage = completion.usage ?? null;
    text = completion.choices?.[0]?.message?.content ?? "";
    finishReason = completion.choices?.[0]?.finish_reason ?? null;
    if (
      !completion.id ||
      completion.model !== input.model ||
      completion.request_id !== input.requestId
    )
      throw new Error("The completion does not match the admitted model and request identity.");
    controller.signal.throwIfAborted();
    if (!finishReason) throw new Error("The response ended without a terminal completion receipt.");
    emit(receipt("completed"));
  } catch (error) {
    const cause = controller.signal.aborted ? controller.signal.reason : error;
    const message = cause instanceof Error ? cause.message : String(cause);
    const status = controller.signal.aborted
      ? cause instanceof Error && cause.name === "TimeoutError"
        ? "timed_out"
        : "cancelled"
      : dispatchAttempted
        ? "failed"
        : "rejected";
    emit(receipt(status, message));
    throw new CliReportedError(message);
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}
