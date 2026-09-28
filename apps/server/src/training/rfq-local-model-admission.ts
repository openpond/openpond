import { createHash } from "node:crypto";

import { quoteRfqHostedModelRequest, type RfqHostedModelChargeQuote } from "./rfq-model-charge.js";

/** This local gate is intentionally narrower than the hosted experiment ledger.
 * A dispatched reservation remains committed at its maximum until an
 * independently verified provider billing receipt is settled elsewhere. */
export type RfqLocalBudgetAuthority = {
  reserve(input: { allocationId: string; requestHash: string; maximumCents: number }): Promise<void>;
  markDispatched(allocationId: string): Promise<void>;
  releaseBeforeDispatch(allocationId: string): Promise<void>;
};

export type RfqLocalModelAdmissionRequest = {
  experimentId: string;
  requestId: string;
  provider: string;
  model: string;
  modelCatalogRaw: Record<string, unknown> | null;
  maximumInputTokens: number | null;
  maximumOutputTokens: number | null;
  /** Both limits must be enforced by the actual provider route, not inferred
   * merely from a model's advertised context window. */
  providerEnforcesTokenCeilings: boolean;
};

export type RfqLocalModelAdmission = {
  quote: RfqHostedModelChargeQuote;
  allocationId: string;
  /** Invoke immediately before the provider stream is first consumed. */
  dispatch(): Promise<void>;
  /** Only a pre-dispatch failure may return reserved capacity. */
  releaseBeforeDispatch(): Promise<void>;
};

export function createRfqLocalModelAdmissionGate(input: {
  enabled: boolean;
  authority: RfqLocalBudgetAuthority | null;
}) {
  return {
    async admit(request: RfqLocalModelAdmissionRequest): Promise<RfqLocalModelAdmission> {
      if (!input.enabled || !input.authority) {
        throw new Error("RFQ local model admission is not explicitly configured.");
      }
      if (!request.experimentId.trim() || !request.requestId.trim()
        || request.provider !== "openpond" || !request.model.trim()) {
        throw new Error("RFQ model request has no admitted experiment, identity, or hosted route.");
      }
      if (!request.providerEnforcesTokenCeilings || !request.modelCatalogRaw
        || request.maximumInputTokens === null || request.maximumOutputTokens === null) {
        throw new Error("RFQ model request has no verified price and provider-enforced token ceilings.");
      }
      const quote = quoteRfqHostedModelRequest({
        modelCatalogRaw: request.modelCatalogRaw,
        maximumInputTokens: request.maximumInputTokens,
        maximumOutputTokens: request.maximumOutputTokens,
      });
      const requestHash = digest({
        experimentId: request.experimentId, requestId: request.requestId,
        provider: request.provider, model: request.model,
        catalog: request.modelCatalogRaw, quote,
      });
      const allocationId = `rfq-model:${request.experimentId}:${request.requestId}`;
      await input.authority.reserve({ allocationId, requestHash, maximumCents: quote.maximumCents });
      let dispatched = false;
      let released = false;
      return {
        quote, allocationId,
        async dispatch() {
          if (released) throw new Error("RFQ model reservation was released before dispatch.");
          await input.authority!.markDispatched(allocationId);
          dispatched = true;
        },
        async releaseBeforeDispatch() {
          if (dispatched) throw new Error("Dispatched RFQ model reservation must remain committed.");
          await input.authority!.releaseBeforeDispatch(allocationId);
          released = true;
        },
      };
    },
  };
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
