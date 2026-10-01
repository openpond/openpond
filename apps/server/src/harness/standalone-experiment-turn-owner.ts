import { contentHash } from "@openpond/harness";
import type { Session, Turn, RuntimeEvent } from "@openpond/contracts";
import type { StandaloneHarnessExperimentSource } from "@openpond/evals/experiments";
import type { streamOpenPondHostedChatTurn } from "@openpond/runtime";
import type { ExperimentModelCase } from "../evaluations/experiment-case-contract.js";
import type { HarnessStateStore } from "../store/harness-state-store.js";
import { ensureLocalHarnessRunOverlay } from "./local-harness-run-overlay.js";
import { resolveStandaloneExperimentSource } from "./standalone-experiment-source.js";
import { sealStandaloneExperimentReceipt } from "./standalone-experiment-receipt.js";
import type { HarnessWorkspace } from "@openpond/contracts";

type ModelStream = typeof streamOpenPondHostedChatTurn;
type OwnedSession = { binding: unknown; stream: ModelStream };

/** The ordinary native turn runtime supplies tools, permissions and traces.
 * The Experiment owner supplies an already admitted, durably budgeted stream.
 * An absent owner after restart fails before dispatch, rather than bypassing
 * the Experiment ledger through the ordinary chat transport. */
export function createStandaloneExperimentTurnOwner(deps: {
  store: HarnessStateStore;
  createSession(request: unknown): Promise<Session>;
  sendTurn(sessionId: string, request: unknown): Promise<Turn>;
  interruptSessionTurn(sessionId: string, reason?: string): Promise<Turn>;
  authorizeWorkspace?: (source: StandaloneHarnessExperimentSource, workspace: HarnessWorkspace) => Promise<void>;
}) {
  const sessions = new Map<string, OwnedSession>();
  async function resolveSessionModelStream(session: Session, turn: Turn): Promise<ModelStream | null> {
    const binding = session.metadata?.standaloneExperiment;
    if (binding === undefined) return null;
    const owner = sessions.get(session.id);
    if (!owner || contentHash(binding) !== contentHash(owner.binding)
      || session.currentProfile || session.profileComponentBinding || session.profileWorkflowBinding
      || turn.sessionId !== session.id || turn.profileSnapshot) {
      throw new Error("Standalone Experiment turn has no matching active execution owner.");
    }
    return owner.stream;
  }
  async function execute(input: {
    executionId: string;
    request: ExperimentModelCase;
    source: StandaloneHarnessExperimentSource;
    stream: ModelStream;
    signal: AbortSignal;
    maxOutputBytes: number;
  }) {
    if (!Number.isSafeInteger(input.maxOutputBytes) || input.maxOutputBytes < 1 || input.maxOutputBytes > 8_388_608) {
      throw new Error("Native Experiment requires a bounded positive output limit.");
    }
    if (!input.request.harness || contentHash(input.request.harness) !== contentHash(input.source)) {
      throw new Error("Native Experiment source differs from its admitted case.");
    }
    if (input.request.environment.kind !== "text") {
      throw new Error("Standalone native Harness execution requires a compatible text Dataset.");
    }
    if (input.request.model.messages.length) {
      throw new Error("Standalone Harness cases use released instructions; additional raw prompt messages are not qualified.");
    }
    input.signal.throwIfAborted();
    const { runtime } = await resolveStandaloneExperimentSource({ store: deps.store, source: input.source,authorizeWorkspace:deps.authorizeWorkspace });
    const binding = {
      executionId: input.executionId, caseId: input.request.id,
      admissionHash: input.request.admissionHash, source: input.source,
      modelConfigurationHash: input.request.model.configurationHash,
    };
    const modelRef = { providerId: input.request.model.providerId, modelId: input.request.model.modelId };
    const session = await deps.createSession({
      provider: modelRef.providerId, modelRef, currentProfile: null,
      hiddenFromDefaultSidebar: true, metadata: { standaloneExperiment: binding },
    });
    if (session.currentProfile || session.profileComponentBinding || session.profileWorkflowBinding) {
      throw new Error("Standalone Experiment session acquired an unrelated Profile.");
    }
    await ensureLocalHarnessRunOverlay({
      store: deps.store, runId: session.id, workspace: runtime.workspace,
      harnessRelease: input.source.harnessRelease, admittedAt: session.createdAt,
    });
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(input.request.timeoutMs)]);
    const stream: ModelStream = async function* (request) {
      if (request.model !== modelRef.modelId) throw new Error("Native Experiment requested a different model.");
      for await (const delta of input.stream({
        ...request, maxTokens: input.request.model.maxOutputTokens,
        temperature: input.request.model.temperature, topP: input.request.model.topP,
        signal: request.signal ? AbortSignal.any([signal, request.signal]) : signal,
      })) yield delta;
    };
    sessions.set(session.id, { binding, stream });
    let interrupt: Promise<Turn> | undefined;
    const onAbort = () => {
      interrupt ??= deps.interruptSessionTurn(session.id, "Standalone Experiment case cancelled or timed out.");
      // Keep the rejection handled while the ordinary turn settles. The owner
      // awaits this promise before releasing its dispatch authority below.
      void interrupt.catch(() => undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    let dispatched = false;
    let settled = false;
    try {
      signal.throwIfAborted();
      const prompt = [input.request.instructions, JSON.stringify({
        input: input.request.input, policyVisibleContext: input.request.policyVisibleContext,
      })].filter(Boolean).join("\n\n");
      dispatched = true;
      const turn = await deps.sendTurn(session.id, { prompt, modelRef, approvalPolicy: "on-request" });
      if (interrupt) await interrupt;
      if (!turn.completedAt || turn.status === "in_progress") throw new Error("Native Experiment turn did not settle.");
      settled = true;
      if (turn.profileSnapshot || !turn.harnessSnapshot
        || contentHash(turn.harnessSnapshot.harnessRelease) !== contentHash(input.source.harnessRelease)
        || contentHash(turn.modelRef) !== contentHash(modelRef)) {
        throw new Error("Native Experiment turn differs from its admitted model or standalone Harness.");
      }
      const events = await deps.store.runtimeEventsForTurn(turn.id);
      if (events.some(event => event.sessionId !== session.id || event.turnId !== turn.id)) {
        throw new Error("Native Experiment trace contains evidence from another case.");
      }
      const output = events.filter(event => event.name === "assistant.delta" && typeof event.output === "string")
        .map(event => event.output).join("");
      const traceHash = contentHash(events);
      const runtimeEventRefs = retainedEventRefs(events);
      const attempt = sealStandaloneExperimentReceipt({
        request: input.request, source: input.source, turn, output, traceHash, runtimeEventRefs,
        cancelled: input.signal.aborted, timedOut: signal.aborted && !input.signal.aborted,
        maxOutputBytes: input.maxOutputBytes,
      });
      return { sessionId: session.id, turn, output: attempt.output, traceHash,
        runtimeEventRefs, cleanupComplete: true, attempt };
    } catch (error) {
      if (dispatched && !settled) {
        const terminal = await (interrupt ?? deps.interruptSessionTurn(session.id, "Standalone Experiment execution failed."));
        if (terminal.status === "in_progress" || !terminal.completedAt) {
          throw new Error("Standalone Experiment cleanup remains unconfirmed.", { cause: error });
        }
      }
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
      sessions.delete(session.id);
    }
  }
  return { execute, resolveSessionModelStream };
}

function retainedEventRefs(events: RuntimeEvent[]): string[] {
  let lastDelta = -1;
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index]?.name.endsWith(".delta")) { lastDelta = index; break; }
  }
  const refs = events.flatMap((event, index) => event.name.endsWith(".delta") && index !== lastDelta ? [] : [event.id]);
  if (refs.length > 10_000) throw new Error("Native Experiment trace exceeds its evidence-reference limit.");
  return refs;
}
