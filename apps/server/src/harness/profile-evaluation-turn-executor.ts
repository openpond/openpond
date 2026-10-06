import { contentHash, type ChatModelRef, type ProfileComponentBinding, type ProfileWorkflowBinding } from "@openpond/harness";
import { FileOutputRefSchema, type ChatAttachment, type FileOutputRef, type OpenPondProfileRef, type RuntimeEvent, type Session, type Turn } from "@openpond/contracts";
import type { TasksetRunManifest } from "@openpond/evals";
import type { RequiredOutputContract } from "@openpond/evals";
import type { executeProfileEvaluationRun } from "@openpond/evals";
import { assertProfileEvaluationSpendAuthority } from "./profile-evaluation-spend-authority.js";
import { profileEvaluationOutput } from "./profile-evaluation-policy-evidence.js";
import { awaitProfileEvaluationTurn } from "./profile-evaluation-owned-turn.js";

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
  interruptSessionTurn?: (sessionId: string, reason?: string) => Promise<Turn>;
  runtimeEventsForTurn: (turnId: string) => Promise<RuntimeEvent[]>;
  attachments?: ChatAttachment[];
  requiredOutputs?: RequiredOutputContract[];
  /** Trusted execution owner, never supplied by a public case payload. */
  assertSpendAuthority?:typeof assertProfileEvaluationSpendAuthority;
  ownedSessionMetadata?:Record<string,unknown>;
  settleSession?:(id:string)=>void|Promise<void>;
  admitSession?:(session:Session)=>Promise<void>;
  validateTerminalTurn?:(session:Session,turn:Turn)=>Promise<void>;
  maximumOutputBytes?:number;
  onInterrupt?:(kind:"cancelled"|"timed_out")=>void;
  retainOutputLimitEvidence?:boolean;
  onOutputLimit?:(outputHash:string)=>void;
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
    await (input.assertSpendAuthority??assertProfileEvaluationSpendAuthority)(input.manifest, member.signal);
    const workCase = Boolean(input.attachments?.length || input.requiredOutputs?.length);
    const session = await input.createSession({
      ...(workCase ? { experience: "work" } : {}),
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
        ...(workCase && input.profileRef.source === "local" ? { workspaceTarget: "local" } : {}),
        ...input.ownedSessionMetadata,
      },
    });
    const prompt = [
      typeof member.task.input === "string" ? member.task.input : JSON.stringify(member.task.input),
      ...(Object.keys(member.task.policyVisibleContext).length
        ? [`Policy-visible task context:\n${JSON.stringify(member.task.policyVisibleContext)}`]
        : []),
    ].join("\n\n") || " ";
    await input.admitSession?.(session);
    try {
    const turn = await awaitProfileEvaluationTurn({signal:member.signal,timeoutMs:input.manifest.limits.timeoutMs,
      onInterrupt:input.onInterrupt,
      ...(input.interruptSessionTurn?{interrupt:(reason:string)=>input.interruptSessionTurn!(session.id,reason)}:{}),
      send:()=>input.sendTurn(session.id, {
      prompt,
      ...(input.binding.schemaVersion === "openpond.profileWorkflowBinding.v1"
        ? { workflowInput: {} }
        : input.binding.target.kind === "agent_action"
          ? { workflowInput: member.task.input } : {}),
      modelRef: input.modelRef,
      approvalPolicy: "on-request",
      ...(workCase ? { sandbox: "workspace-write", codexPermissionMode: "default" } : {}),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    })});
    if (turn.status === "in_progress" || !turn.completedAt) {
      throw new Error("Workflow evaluation turn did not settle.");
    }
    await input.validateTerminalTurn?.(session,turn);
    if (!turn.harnessSnapshot
      || turn.harnessSnapshot.harnessRelease.id !== source.harnessRelease.id
      || turn.harnessSnapshot.harnessRelease.contentHash !== source.harnessRelease.contentHash) {
      throw new Error("Workflow evaluation turn executed a different Harness release.");
    }
    if (!turn.modelRef || contentHash(turn.modelRef) !== contentHash(input.modelRef)) {
      throw new Error("Workflow evaluation turn executed a different model.");
    }
    const events = await input.runtimeEventsForTurn(turn.id);
    const outputs = events
      .filter((event) => event.name === "workspace_action_result"
        && (event.action === "sandbox_save_output" || event.action === "work_output_save")
        && event.status === "completed"
        && event.turnId === turn.id)
      .flatMap((event) => findFileOutputs(event.data))
      .filter((output) => output.sourceTaskId === session.id
        && output.sourceTurnId === turn.id && output.location.kind !== "external");
    const matchedOutputs = (input.requiredOutputs ?? []).flatMap((required) => {
      const output = [...outputs].reverse().find((candidate) => candidate.title === required.path
        && candidate.contentType === required.mediaType
        && (required.maxBytes === null || candidate.sizeBytes <= required.maxBytes));
      return output ? [output] : [];
    });
    const artifactRefs = matchedOutputs.map((output) => ({
      id: `${session.id}/${output.id}/${output.revision}/${output.title}`,
      contentHash: output.sha256,
      mediaType: output.contentType,
      sizeBytes: output.sizeBytes,
    }));
    // Stream deltas remain in the complete trace and reconstructed output.
    // A long turn can emit more delta events than a grader receipt permits;
    // retain its last stream anchor and every substantive event for grading.
    let lastDeltaIndex = -1;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index]?.name.endsWith(".delta")) {
        lastDeltaIndex = index;
        break;
      }
    }
    const runtimeEventRefs = events.flatMap((event, index) =>
      event.name.endsWith(".delta") && index !== lastDeltaIndex ? [] : [event.id]);
    if (runtimeEventRefs.length + artifactRefs.length > 10_000) {
      throw new Error("Profile evaluation produced more than 10,000 substantive evidence references.");
    }
    const output = profileEvaluationOutput(events, source.target.kind);
    const maxOutputBytes=Math.min(input.manifest.limits.maxOutputBytes,input.maximumOutputBytes??input.manifest.limits.maxOutputBytes);
    if (!Number.isSafeInteger(maxOutputBytes)||maxOutputBytes<1)throw new Error("Profile evaluation requires a positive bounded output limit.");
    const outputOverflow=Buffer.byteLength(output,"utf8")>maxOutputBytes;
    if(outputOverflow&&!input.retainOutputLimitEvidence) {
      throw new Error(`Profile evaluation case exceeded its ${maxOutputBytes}-byte output limit.`);
    }
    if(outputOverflow)input.onOutputLimit?.(contentHash(output));
    return {
      evidence: {
        output: { text: outputOverflow?"":output },
        runtimeEventRefs,
        artifactRefs: artifactRefs.map((artifact) => artifact.id),
        ...(outputOverflow?{infrastructureError:`Profile evaluation case exceeded its ${maxOutputBytes}-byte output limit.`}
          :turn.status !== "completed" ? { infrastructureError: turn.error ?? `Workflow evaluation turn ${turn.status}.` } : {}),
      },
      traceHash: contentHash(events),
      retainedEvidenceRef: { sessionId: session.id, turnId: turn.id },
      artifactRefs,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      latencyMs: Math.max(0, Date.parse(turn.completedAt) - Date.parse(turn.startedAt)),
      costUsd: null,
      terminal: turn.status === "completed"&&!outputOverflow,
      failureClass: turn.status === "completed"&&!outputOverflow ? null : turn.status === "interrupted" ? "cancelled" : "infrastructure_failure",
    };
    }finally{await input.settleSession?.(session.id);}
  };
}

function findFileOutputs(value: unknown, depth = 0): FileOutputRef[] {
  if (value == null || depth > 8) return [];
  const parsed = FileOutputRefSchema.safeParse(value);
  if (parsed.success) return [parsed.data];
  if (Array.isArray(value)) return value.flatMap((item) => findFileOutputs(item, depth + 1));
  if (typeof value !== "object") return [];
  return Object.values(value as Record<string, unknown>)
    .flatMap((item) => findFileOutputs(item, depth + 1));
}
