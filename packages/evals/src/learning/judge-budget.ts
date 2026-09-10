import { z } from "zod";
import { contentHash, ReleaseHashSchema, ReleaseIdSchema } from "@openpond/harness";
import { BoundJudgeResponseSchema, type BoundJudgeRequest, type BoundJudgeResponse } from "./model-judge.js";

export const JudgeCallReservationSchema = z.object({
  id: ReleaseIdSchema, requestHash: ReleaseHashSchema, reservedUsd: z.number().finite().positive(),
  status: z.enum(["reserved", "settled", "not_dispatched"]), response: BoundJudgeResponseSchema.nullable(),
}).strict().superRefine((entry, context) => {
  if ((entry.status === "settled") !== (entry.response !== null)) context.addIssue({ code: "custom", path: ["response"], message: "Only settled calls have a provider response." });
});
export type JudgeCallReservation = z.infer<typeof JudgeCallReservationSchema>;
export interface JudgeBudgetState { maximumSpendUsd: number; calls: JudgeCallReservation[] }
export interface JudgeBudgetStore {
  /** Atomic and durable. A dispatch transaction must also enforce the owner's
   * current lease and running state. Settlement remains writable after cancel. */
  transaction<T>(intent: "dispatch" | "settle", update: (state: JudgeBudgetState) => { calls: JudgeCallReservation[]; result: T }): Promise<T>;
}

export function judgeCommittedSpend(calls: JudgeCallReservation[]): number {
  return calls.reduce((total, entry) => total + (entry.status === "not_dispatched" ? 0 : entry.response?.costUsd ?? entry.reservedUsd), 0);
}

/** A reservation with no response is an uncertain charge, never permission to
 * retry. Replays return the retained response without another provider call. */
export function createBudgetedJudgeExecutor(options: {
  store: JudgeBudgetStore;
  maximumCharge: (request: BoundJudgeRequest) => number;
  dispatch: (request: BoundJudgeRequest, signal?: AbortSignal) => Promise<BoundJudgeResponse>;
}) {
  return async (callId: string, request: BoundJudgeRequest, signal?: AbortSignal): Promise<BoundJudgeResponse> => {
    signal?.throwIfAborted();
    const requestHash = contentHash(request);
    const reservedUsd = z.number().finite().positive().parse(options.maximumCharge(request));
    const claim = await options.store.transaction<{ response: BoundJudgeResponse | null }>("dispatch", state => {
      const previous = state.calls.find(entry => entry.id === callId);
      if (previous) {
        if (previous.requestHash !== requestHash) throw new Error("model_judge_call_identity_conflict");
        if (previous.response) {
          if (previous.response.costUsd !== null && previous.response.costUsd > previous.reservedUsd) throw new Error("model_judge_charge_exceeded_reservation");
          return { calls: state.calls, result: { response: previous.response } };
        }
        throw new Error(previous.status === "not_dispatched" ? "model_judge_call_cancelled" : "model_judge_charge_unresolved");
      }
      if (!Number.isFinite(state.maximumSpendUsd) || state.maximumSpendUsd < 0 || judgeCommittedSpend(state.calls) + reservedUsd > state.maximumSpendUsd) throw new Error("model_judge_budget_exceeded");
      const entry = JudgeCallReservationSchema.parse({ id: callId, requestHash, reservedUsd, status: "reserved", response: null });
      return { calls: [...state.calls, entry], result: { response: null } };
    });
    if (claim.response) return claim.response;
    if (signal?.aborted) {
      await options.store.transaction("settle", state => ({ calls: state.calls.map(entry => entry.id === callId ? { ...entry, status: "not_dispatched" as const } : entry), result: null }));
      signal.throwIfAborted();
    }
    // Provider exceptions and process loss leave the reservation charged. The
    // provider may have accepted work even when no response reaches this owner.
    const response = BoundJudgeResponseSchema.parse(await options.dispatch(request, signal));
    await options.store.transaction("settle", state => {
      const previous = state.calls.find(entry => entry.id === callId);
      if (!previous || previous.requestHash !== requestHash || previous.status === "not_dispatched") throw new Error("model_judge_reservation_missing");
      if (previous.response && contentHash(previous.response) !== contentHash(response)) throw new Error("model_judge_settlement_conflict");
      return { calls: state.calls.map(entry => entry.id === callId ? { ...entry, status: "settled" as const, response } : entry), result: null };
    });
    if (response.costUsd !== null && response.costUsd > reservedUsd) throw new Error("model_judge_charge_exceeded_reservation");
    return response;
  };
}
