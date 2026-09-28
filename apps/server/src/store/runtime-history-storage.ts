import type { RuntimeEvent, Session, Turn } from "@openpond/contracts";

export type TurnHistoryPage = {
  turns: Turn[];
  nextBeforeSortIndex: number | null;
};

export type RuntimeEventHistoryPage = {
  entries: Array<{ sequence: number; event: RuntimeEvent }>;
  totalMatchingEvents: number;
  remainingMatchingEvents: number;
};

/** Bounded asynchronous reads shared by local and hosted runtime storage. */
export interface RuntimeHistoryStorage {
  getSession(sessionId: string): Promise<Session | null>;
  turnPageForSession(input: {
    sessionId: string;
    beforeSortIndex?: number | null;
    limit?: number;
  }): Promise<TurnHistoryPage>;
  runtimeEventPageRows(input: {
    sessionId: string | null;
    afterSequence: number;
    beforeSequence: number | null;
    limit: number;
  }): Promise<RuntimeEventHistoryPage>;
}
