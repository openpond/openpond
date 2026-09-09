import { LearningIterationSchema } from "./contracts.js";
import { LearningDomainError } from "./errors.js";
import { LearningChainSchema, LearningIterationReservationSchema } from "./iteration-reservation-contracts.js";
import type { LearningCommand } from "./operations.js";
import { LearningConflictError, requireLearningResource, type LearningResourcePointer, type LearningTransaction } from "./repository.js";

/** Only a reservation that has never been dispatched can release spend locally.
 * Submitted executions require authoritative cancellation and settlement. */
export async function cancelLearningIterationReservation(
  transaction: LearningTransaction,
  input: Extract<LearningCommand, { action: "cancel_iteration_reservation" }>,
  now: string,
): Promise<LearningResourcePointer[]> {
  const iteration = await requireLearningResource(transaction, "iteration", input.iterationId);
  if (iteration.revision !== input.expectedRevision) throw new LearningConflictError("iteration", iteration.id, input.expectedRevision, iteration.revision);
  const reservation = await requireLearningResource(transaction, "reservation", iteration.id);
  if (iteration.status === "cancelled") return [{ kind: "iteration", id: iteration.id, revision: iteration.revision }];
  if (iteration.trainingJob || iteration.evaluationJob || !["ready", "waiting_for_data", "waiting_for_review"].includes(iteration.status)) {
    throw new LearningDomainError("learning_execution_cancellation_required", 409);
  }
  const updated = LearningIterationSchema.parse({ ...iteration, revision: iteration.revision + 1, status: "cancelled", updatedAt: now });
  const released = LearningIterationReservationSchema.parse({
    ...reservation, revision: reservation.revision + 1,
    budget: { ...reservation.budget, reservedSpendUsd: 0, settledSpendUsd: 0, settledAt: now }, updatedAt: now,
  });
  await transaction.put("iteration", updated, iteration.revision, { parentId: reservation.chainId, status: updated.status });
  await transaction.put("reservation", released, reservation.revision, { parentId: reservation.chainId, status: reservation.outcome });
  const chain = await requireLearningResource(transaction, "chain", reservation.chainId);
  if (chain.activeIterationId === iteration.id) {
    await transaction.put("chain", LearningChainSchema.parse({ ...chain, revision: chain.revision + 1, activeIterationId: null, updatedAt: now }), chain.revision, { parentId: chain.modelProjectId });
  }
  // Consumption is retained. Retry/replay is an explicit operation, never a
  // side effect of cancelling that silently makes the same examples new again.
  return [{ kind: "iteration", id: updated.id, revision: updated.revision }, { kind: "reservation", id: released.id, revision: released.revision }];
}
