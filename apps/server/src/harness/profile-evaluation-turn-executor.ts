import { contentHash, type ChatModelRef, type ProfileComponentBinding, type ProfileWorkflowBinding } from "@openpond/harness";
import type { OpenPondProfileRef, RuntimeEvent, Session, Turn } from "@openpond/contracts";
import type { TasksetRunManifest } from "@openpond/evals";
import type { executeProfileEvaluationRun } from "@openpond/evals";

type ExecuteCase = Parameters<typeof executeProfileEvaluationRun>[0]["execute"];

/** Execute a workflow case as an ordinary source-bound app-server turn. The
 * app-server supplies the same connected apps, tool permissions and approvals
 * used by Work; the Taskset runner supplies only policy-visible task fields. */
export function createProfileWorkflowEvaluationExecutor(input: {
  manifest: TasksetRunManifest;
  profileRef: OpenPondProfileRef;
  binding: ProfileWorkflowBinding | ProfileComponentBinding;
  modelRef: ChatModelRef;
  modelConfigurationHash: string;
  createSession: (request: unknown) => Promise<Session>;
  sendTurn: (sessionId: string, request: unknown) => Promise<Turn>;
  runtimeEventsForTurn: (turnId: string) => Promise<RuntimeEvent[]>;
}): ExecuteCase {
  const source = input.manifest.profileEvaluation;
  const policy = input.manifest.policy;
  if (!source || policy.kind !== "model"
    || input.manifest.execution.kind !== "harness") {
    throw new Error("Profile evaluation requires a released source and model policy.");
  }
  if (source.profileId !== input.profileRef.profileId
    || source.profileId !== input.binding.profileId
    || source.sourceRevision !== input.binding.sourceRevision
    || source.harnessRelease.id !== input.binding.harnessRelease.id
    || source.harnessRelease.contentHash !== input.binding.harnessRelease.contentHash
    || (input.binding.schemaVersion === "openpond.profileWorkflowBinding.v1"
      ? source.target.kind !== "workflow" || source.target.workflowId !== input.binding.workflowId
      : source.target.kind === "workflow" || contentHash(source.target) !== contentHash(input.binding.target))) {
    throw new Error("Profile evaluation binding differs from its admitted source.");
  }
  if (policy.model.provider !== input.modelRef.providerId
    || policy.model.model !== input.modelRef.modelId
    || policy.configurationHash !== input.modelConfigurationHash) {
    throw new Error("Workflow evaluation model differs from its admitted configuration.");
  }
  return async (member) => {
    if (contentHash(member.source) !== contentHash(source)) {
      throw new Error("Workflow evaluation case differs from its admitted Profile source.");
    }
    member.signal?.throwIfAborted();
    const session = await input.createSession({
      provider: input.modelRef.providerId,
      modelRef: input.modelRef,
      currentProfile: input.profileRef,
      ...(input.binding.schemaVersion === "openpond.profileWorkflowBinding.v1"
        ? { profileWorkflowBinding: input.binding }
        : { profileComponentBinding: input.binding }),
      hiddenFromDefaultSidebar: true,
      metadata: {
        profileEvaluationRun: { id: input.manifest.id, contentHash: input.manifest.contentHash },
        taskId: member.task.id,
        seed: member.seed,
      },
    });
    const prompt = [
      ...(input.binding.schemaVersion === "openpond.profileWorkflowBinding.v1" ? [] : [
        typeof member.task.input === "string" ? member.task.input : JSON.stringify(member.task.input),
      ]),
      ...(Object.keys(member.task.policyVisibleContext).length
        ? [`Policy-visible task context:\n${JSON.stringify(member.task.policyVisibleContext)}`]
        : []),
    ].join("\n\n") || " ";
    const turn = await input.sendTurn(session.id, {
      prompt,
      ...(input.binding.schemaVersion === "openpond.profileWorkflowBinding.v1"
        || input.binding.target.kind === "agent_action"
        ? { workflowInput: member.task.input } : {}),
      modelRef: input.modelRef,
      approvalPolicy: "on-request",
    });
    if (turn.status === "in_progress" || !turn.completedAt) {
      throw new Error("Workflow evaluation turn did not settle.");
    }
    if (!turn.harnessSnapshot
      || turn.harnessSnapshot.harnessRelease.id !== source.harnessRelease.id
      || turn.harnessSnapshot.harnessRelease.contentHash !== source.harnessRelease.contentHash) {
      throw new Error("Workflow evaluation turn executed a different Harness release.");
    }
    if (!turn.modelRef || contentHash(turn.modelRef) !== contentHash(input.modelRef)) {
      throw new Error("Workflow evaluation turn executed a different model.");
    }
    const events = await input.runtimeEventsForTurn(turn.id);
    const assistantOutput = events.filter((event) => event.name === "assistant.delta" && typeof event.output === "string")
      .map((event) => event.output ?? "").join("");
    const actionOutput = input.binding.schemaVersion === "openpond.profileComponentBinding.v1"
      && input.binding.target.kind === "agent_action"
      ? events.find((event) => event.name === "workspace_action_result" && event.action === "profile_workflow_action")?.output
      : null;
    if (input.binding.schemaVersion === "openpond.profileComponentBinding.v1"
      && input.binding.target.kind === "agent_action" && typeof actionOutput !== "string") {
      throw new Error("Profile Agent action evaluation did not produce a released action result.");
    }
    const output = typeof actionOutput === "string" ? actionOutput : assistantOutput;
    return {
      evidence: {
        output: { text: output },
        runtimeEventRefs: events.map((event) => event.id),
        artifactRefs: [],
        ...(turn.status !== "completed" ? { infrastructureError: turn.error ?? `Workflow evaluation turn ${turn.status}.` } : {}),
      },
      traceHash: contentHash(events),
      artifactRefs: [],
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      latencyMs: Math.max(0, Date.parse(turn.completedAt) - Date.parse(turn.startedAt)),
      costUsd: null,
      terminal: turn.status === "completed",
      failureClass: turn.status === "completed" ? null : turn.status === "interrupted" ? "cancelled" : "infrastructure_failure",
    };
  };
}
