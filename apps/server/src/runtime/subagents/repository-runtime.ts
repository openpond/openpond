import type {
  RuntimeEvent,
  Session,
  SubagentRun,
} from "@openpond/contracts";
import { event } from "../../utils.js";
import type { BackgroundWorkerQueue } from "../background-worker-queue.js";
import type { TurnRunnerDependencies } from "../turns/ports.js";

type Store = TurnRunnerDependencies["store"];

export function createSubagentRepositoryRuntime(deps: {
  createSession: TurnRunnerDependencies["createSession"];
  queue?: BackgroundWorkerQueue;
  upsertRun?: Store["upsertSubagentRun"];
  getRun?: Store["getSubagentRun"];
  listRuns?: Store["listSubagentRuns"];
  appendMessage?: Store["appendSubagentMessage"];
  listUsageRecords?: Store["listModelUsageRecords"];
  notifyRunStateChanged?: ((run: SubagentRun) => void) | null;
  appendRuntimeEvent(runtimeEvent: RuntimeEvent): Promise<void>;
}) {
  function available(): boolean {
    return Boolean(
      deps.createSession &&
      deps.queue &&
      deps.upsertRun &&
      deps.getRun &&
      deps.listRuns &&
      deps.appendMessage &&
      deps.listUsageRecords
    );
  }

  async function upsertRunAndNotify(run: SubagentRun): Promise<SubagentRun> {
    if (!deps.upsertRun) throw new Error("Subagent runtime dependencies are not available.");
    const updated = await deps.upsertRun(run);
    deps.notifyRunStateChanged?.(updated);
    return updated;
  }

  function requireDependencies() {
    if (
      !deps.createSession ||
      !deps.queue ||
      !deps.upsertRun ||
      !deps.getRun ||
      !deps.listRuns ||
      !deps.appendMessage ||
      !deps.listUsageRecords
    ) {
      throw new Error("Subagent runtime dependencies are not available.");
    }
    return {
      createSession: deps.createSession,
      queue: deps.queue,
      upsertRun: upsertRunAndNotify,
      getRun: deps.getRun,
      listRuns: deps.listRuns,
      appendMessage: deps.appendMessage,
      listUsageRecords: deps.listUsageRecords,
    };
  }

  async function appendReceipt(input: {
    parentSession: Session;
    parentTurnId?: string | null;
    run: SubagentRun;
    childSession?: Session | null;
    eventName: Extract<RuntimeEvent["name"], `subagent.${string}`>;
    status: RuntimeEvent["status"];
    output: string;
  }): Promise<void> {
    await deps.appendRuntimeEvent(event({
      sessionId: input.parentSession.id,
      turnId: input.parentTurnId ?? undefined,
      name: input.eventName,
      source: "server",
      appId: input.parentSession.appId,
      status: input.status,
      output: input.output,
      data: {
        run: input.run,
        childSessionId: input.run.childSessionId,
        parentGoalId: input.run.parentGoalId,
        ...(input.childSession ? { childSession: sessionShell(input.childSession) } : {}),
      },
    }));
  }

  return {
    appendReceipt,
    available,
    requireDependencies,
    upsertRunAndNotify,
  };
}

function sessionShell(session: Session): Session {
  const { metadata: _metadata, ...shell } = session;
  return shell;
}
