import { AsyncLocalStorage } from "node:async_hooks";
export type ScheduledAdmissionGuard = {
  /** Runs synchronously inside canonical Run SQLite admission, while the
   * actual schedule owner/revision lease transaction remains locked. */
  withAdmission<T>(write: () => T): T;
  assertExecution(executionId: string): void;
};
const admissions = new AsyncLocalStorage<ScheduledAdmissionGuard>();
export const currentScheduledAdmissionGuard = () => admissions.getStore();
export function withScheduledAdmission<T>(
  guard: ScheduledAdmissionGuard,
  run: () => T,
): T {
  return admissions.run(guard, run);
}

/** Server-local proof: thrown only before invoking the underlying transport. */
export class ScheduledTransportNotInvokedError extends Error {
  constructor(readonly executionId: string, readonly requestId: string, cause: unknown) {
    super("The scheduled request was refused before provider transport.", { cause });
  }
}
/** The canonical insertion callback was never invoked. */
export class ScheduledAdmissionRejectedError extends Error {
  constructor(readonly scheduleId:string,readonly operationId:string,readonly configurationHash:string) {
    super("The scheduled admission lost its exact owner lease before Run insertion.");
  }
}
