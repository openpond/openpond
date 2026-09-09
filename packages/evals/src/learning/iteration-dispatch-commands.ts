import { LearningIterationSchema } from "./contracts.js";
import { LearningDomainError } from "./errors.js";
import { LearningIterationDispatchSchema } from "./iteration-dispatch-contracts.js";
import { cancelLearningIterationReservation } from "./iteration-reservation-cancellation.js";
import type { LearningCommand } from "./operations.js";
import { LearningConflictError, requireLearningResource, type LearningResourcePointer, type LearningTransaction } from "./repository.js";

type DispatchCommand = Extract<LearningCommand, { action: "cancel_iteration" | "retry_iteration_dispatch" }>;

export async function commandLearningIterationDispatch(tx: LearningTransaction, input: DispatchCommand, now: string): Promise<LearningResourcePointer[]> {
  const iteration = await requireLearningResource(tx, "iteration", input.iterationId);
  if (iteration.revision !== input.expectedRevision) throw new LearningConflictError("iteration", iteration.id, input.expectedRevision, iteration.revision);
  const dispatch = await tx.get("dispatch", iteration.dispatchId);
  if (input.action === "cancel_iteration" && !dispatch) return cancelLearningIterationReservation(tx, { ...input, action: "cancel_iteration_reservation" }, now);
  if (!dispatch) throw new LearningDomainError("learning_dispatch_not_started", 409);
  if (dispatch.state === "settled") throw new LearningDomainError("learning_execution_already_terminal", 409);
  if (input.action === "retry_iteration_dispatch" && dispatch.state !== "blocked") throw new LearningDomainError("learning_dispatch_not_blocked", 409);
  const cancelling = input.action === "cancel_iteration" || Boolean(dispatch.cancelRequestedAt);
  const updated = LearningIterationSchema.parse({ ...iteration, revision: iteration.revision + 1,
    status: cancelling ? "cancelling" : iteration.status, failure: null, updatedAt: now });
  const resumed = LearningIterationDispatchSchema.parse({ ...dispatch, revision: dispatch.revision + 1,
    state: dispatch.execution ? "submitted" : dispatch.submission ? "prepared" : "preparing",
    cancelRequestedAt: cancelling ? dispatch.cancelRequestedAt ?? now : null,
    consecutiveFailures: 0, nextAttemptAt: null, lastError: null, updatedAt: now });
  // Preserve an in-flight lease. Its owner observes cancellation on the next
  // transition, and a replacement worker may claim only after that lease ends.
  await tx.put("dispatch", resumed, dispatch.revision, { parentId: iteration.id, status: resumed.state });
  await tx.put("iteration", updated, iteration.revision, { parentId: dispatch.chainId, status: updated.status });
  return [{ kind: "iteration", id: updated.id, revision: updated.revision }, { kind: "dispatch", id: resumed.id, revision: resumed.revision }];
}
