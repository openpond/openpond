import type { LearningTransaction } from "./repository.js";

/** Outstanding reservations survive midnight; settled spend belongs to its UTC day. */
export async function readLearningIterationBudget(transaction: LearningTransaction, chainId: string, now: string) {
  const day = new Date(now).toISOString().slice(0, 10);
  let reservedSpendUsd = 0;
  let settledSpendUsd = 0;
  let afterId: string | undefined;
  do {
    const page = await transaction.list("reservation", { parentId: chainId, limit: 100, ...(afterId ? { afterId } : {}) });
    for (const { budget } of page.items) {
      reservedSpendUsd += budget.reservedSpendUsd;
      if (budget.settledAt && new Date(budget.settledAt).toISOString().slice(0, 10) === day) settledSpendUsd += budget.settledSpendUsd;
    }
    afterId = page.nextCursor ?? undefined;
  } while (afterId);
  return { reservedSpendUsd, settledSpendUsd, committedSpendUsd: reservedSpendUsd + settledSpendUsd };
}
