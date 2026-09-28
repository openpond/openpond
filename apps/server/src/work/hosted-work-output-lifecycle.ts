import { randomUUID } from "node:crypto";
import type { RuntimeEvent, Session, Turn } from "@openpond/contracts";
import type { AgentHostStorageClient } from "@openpond/agent-runtime";
import type { AppServerSandboxRequest } from "../runtime/app-server-sandbox-tools.js";
import { HostedWorkOutputStorage } from "../store/hosted-work-output-storage.js";
import { createWorkOutputService } from "./work-output-service.js";

/** Hosted saving never writes output authority or cleanup intent to the child's disk. */
export function createHostedWorkOutputLifecycle(input: {
  client: AgentHostStorageClient;
  storeDir: string;
  sandboxRequest: AppServerSandboxRequest;
  getTurn(turnId: string): Promise<Turn | null>;
  runtimeEventsForSession(sessionId: string): Promise<RuntimeEvent[]>;
  appendRuntimeEvent(event: RuntimeEvent): Promise<void>;
}) {
  const managedPersistence = new HostedWorkOutputStorage(input.client);
  const outputs = createWorkOutputService({
    deviceId: "hosted-postgres",
    storeDir: input.storeDir,
    sandboxRequest: input.sandboxRequest,
    runtimeEventsForSession: input.runtimeEventsForSession,
    managedPersistence: {
      sourceTurnStartedAt: async (sessionId, turnId) => {
        const turn = await input.getTurn(turnId);
        if (!turn || turn.sessionId !== sessionId) throw new Error("Hosted output turn is unavailable.");
        return turn.startedAt;
      },
      save: (request) => managedPersistence.save(request),
      saveSandboxFile: (request) => managedPersistence.saveSandboxFile(request),
    },
  });
  async function finalizeWorkTurn(request: {
    session: Session;
    turnId: string;
    outcome: "completed" | "failed" | "interrupted";
  }): Promise<Session> {
    if (request.session.experience !== "work" || request.session.workspaceKind !== "sandbox" ||
        !request.session.workspaceId) return request.session;
    const saved = await outputs.saveAllWorkOutputs({
      session: request.session, sourceTurnId: request.turnId,
    });
    for (const output of saved) {
      await input.appendRuntimeEvent({
        id: randomUUID(), timestamp: new Date().toISOString(),
        name: "workspace_action_result", source: "server",
        sessionId: request.session.id, turnId: request.turnId,
        action: "sandbox_save_output", status: "completed",
        output: `Saved ${output.outputRef.title} as a managed Work output.`,
        data: output,
      });
    }
    return request.session;
  }
  return { finalizeWorkTurn };
}
