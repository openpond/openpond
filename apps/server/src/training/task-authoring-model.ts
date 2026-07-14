import { z } from "zod";
import {
  TaskDesignProposalSchema,
  type ChatModelRef,
  type CodexReasoningEffort,
  type AuthoringRepair,
  type TaskCreationRequest,
  type TaskDesignProposal,
  type TrainingSourceRef,
} from "@openpond/contracts";

const ModelProposalEnvelopeSchema = z.object({
  schemaVersion: z.literal("openpond.taskAuthoringDecision.v1"),
  proposal: TaskDesignProposalSchema,
});

const DEFAULT_TASK_AUTHORING_TIMEOUT_MS = 180_000;

export type TaskAuthoringEvidence = {
  source: TrainingSourceRef;
  excerpts: Array<{ role: "user" | "assistant"; text: string; turnId: string }>;
};

export type TaskAuthoringModelStream = (input: {
  model: ChatModelRef;
  reasoningEffort: CodexReasoningEffort | null;
  messages: Array<{ role: "system" | "user"; content: string }>;
  signal: AbortSignal;
}) => AsyncIterable<{ text?: string }>;

export async function authorTaskDesignWithModel(input: {
  id: string;
  model: ChatModelRef;
  reasoningEffort: CodexReasoningEffort | null;
  evidence: TaskAuthoringEvidence[];
  skillText: string;
  methodHint?: TaskCreationRequest["methodHint"];
  instruction?: string | null;
  currentProposal?: TaskDesignProposal | null;
  stream: TaskAuthoringModelStream;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<{ proposal: TaskDesignProposal; repairHistory: AuthoringRepair[] }> {
  const timeout = authoringTimeoutSignal(input.signal, input.timeoutMs ?? DEFAULT_TASK_AUTHORING_TIMEOUT_MS);
  try {
    const messages = taskAuthoringMessages(input);
    const first = await collect(input.stream({ model: input.model, reasoningEffort: input.reasoningEffort, messages, signal: timeout.signal }));
    const parsed = parseEnvelope(first);
    const firstIssue = parsed ? proposalCompatibilityIssue(parsed.proposal, input.evidence) : null;
    if (parsed && !firstIssue) return { proposal: parsed.proposal, repairHistory: [] };
    const repairReason = parsed
      ? `The prior proposal is incompatible with the current Taskset materializer: ${firstIssue} Redesign it without changing the selected evidence.`
      : `The prior response was invalid. Return only valid JSON matching openpond.taskAuthoringDecision.v1. Invalid response:\n${first.slice(0, 20_000)}`;
    const repaired = await collect(input.stream({
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      signal: timeout.signal,
      messages: [...messages, { role: "user", content: repairReason }],
    }));
    const repairedParsed = parseEnvelope(repaired);
    if (!repairedParsed) throw new Error("Task authoring model returned invalid structured output after one repair attempt.");
    const repairedIssue = proposalCompatibilityIssue(repairedParsed.proposal, input.evidence);
    if (repairedIssue) throw new Error(`Task authoring model returned an incompatible proposal after one repair attempt: ${repairedIssue}`);
    return { proposal: repairedParsed.proposal, repairHistory: [{ attempt: 1, summary: "Repaired invalid or method-incompatible TaskDesignProposal output.", createdAt: new Date().toISOString() }] };
  } catch (error) {
    if (timeout.signal.aborted && !input.signal.aborted) {
      throw new Error(`Task authoring timed out after ${timeout.timeoutMs}ms.`);
    }
    throw error;
  } finally {
    timeout.cleanup();
  }
}

function taskAuthoringMessages(input: { id: string; evidence: TaskAuthoringEvidence[]; skillText: string; methodHint?: TaskCreationRequest["methodHint"]; instruction?: string | null; currentProposal?: TaskDesignProposal | null }): Array<{ role: "system" | "user"; content: string }> {
  return [
    {
      role: "system",
      content: [
        "You are OpenPond Taskset Authoring.",
        "Use only the consented evidence supplied below.",
        "Diagnose the work before designing a task. Repetition alone is not evidence that weights are the right intervention.",
        "Produce one provider-neutral capability diagnosis and, only when justified, one task design. Separate policy-visible input from privileged outcomes.",
        "The diagnosis must identify stableBehavior, changingKnowledge, requiredContext, requiredTools, the recommended intervention, whether training is eligible, and an evidence-backed rationale.",
        "Use intervention=no_training when the behavior is already reliable or lacks a coherent repeated job. Use prompting when instructions or application logic are sufficient. Use retrieval when the primary value is changing facts or documents.",
        "Prefer deterministic graders. Model judges must be calibrated and cannot silently become reward.",
        "Do not fabricate expert approval, preferences, corrections, or rewards.",
        "A methodHint is a user preference, not permission to misclassify the evidence. Explain a different recommendation when the hint is unsuitable.",
        "Historical assistant messages are candidate outcomes, not automatically approved truth. Exclude stale, contradictory, speculative, context-incomplete, or unsuccessful answers.",
        "Explicitly selected local chats may supply extracted candidate examples when the assistant output is complete, internally consistent, and supports the stated objective. Do not require a separate historical expert-approval field; final approval occurs when the user creates the Taskset.",
        "For each usable example, populate proposedExamples with its exact input and expected output, source and turn provenance, split, origin, and rationale.",
        "Use origin=extracted only when inputPrompt and expectedOutputText exactly match the selected user/assistant pair. Label any repaired or newly generated text corrected or synthetic.",
        "Keep every source cluster wholly within one data split. Evaluation examples should come from independent conversations when available.",
        "For no_training, prompting, or retrieval recommendations, set trainingEligible=false, proposedMethod to none or retrieval as appropriate, and leave proposedExamples, graders, fixtures, and generated files empty.",
        "Recommend provider-neutral methods from the evidence. A versioned executable environment with deterministic reward variance may justify GRPO even when the current local destination can execute only a separately labeled SFT trajectory bootstrap.",
        "For Cross-System Operations traces, preserve the four required tools, the shared tool-contract hash, structured tool messages, split-isolated worlds, and the exact trajectory verifier. Never relabel the primary GRPO recommendation as SFT because local GPU execution is unavailable.",
        "Generated verifier paths and custom-verifier modules must start with graders/. Fixture files must start with fixtures/ and environment files with environment/.",
        "Return JSON only: {schemaVersion:'openpond.taskAuthoringDecision.v1', proposal: TaskDesignProposal}.",
        `TaskDesignProposal JSON schema:\n${JSON.stringify(z.toJSONSchema(TaskDesignProposalSchema), null, 2)}`,
        "Follow the bundled Taskset Authoring skill below:",
        input.skillText,
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify({ proposalId: input.id, methodHint: input.methodHint ?? null, instruction: input.instruction ?? null, currentProposal: input.currentProposal ?? null, evidence: input.evidence }, null, 2),
    },
  ];
}

function proposalCompatibilityIssue(proposal: TaskDesignProposal, evidence: TaskAuthoringEvidence[]): string | null {
  const nonTraining = new Set(["no_training", "prompting", "retrieval"]);
  if (nonTraining.has(proposal.diagnosis.intervention) && proposal.diagnosis.trainingEligible) return `${proposal.diagnosis.intervention} cannot be trainingEligible.`;
  if (proposal.diagnosis.intervention === "retrieval" && proposal.proposedMethod !== "retrieval") return "Retrieval diagnoses must set proposedMethod=retrieval.";
  if ((proposal.diagnosis.intervention === "no_training" || proposal.diagnosis.intervention === "prompting") && proposal.proposedMethod !== "none") return `${proposal.diagnosis.intervention} diagnoses must set proposedMethod=none.`;
  if (!proposal.diagnosis.trainingEligible && (proposal.proposedExamples.length || proposal.proposedGraders.length || proposal.graderFixtures.length || proposal.generatedFiles.length)) return "Non-training diagnoses must not package training examples, graders, fixtures, or generated files.";
  if (proposal.diagnosis.trainingEligible && proposal.diagnosis.stableBehavior.length === 0) return "Training-eligible diagnoses must identify at least one stable behavior.";
  const selectedSourceIds = new Set(evidence.map((item) => item.source.id));
  if (proposal.sourceIds.some((sourceId) => !selectedSourceIds.has(sourceId))) return "proposal sourceIds must stay within the selected evidence.";
  for (const example of proposal.proposedExamples) {
    if (!selectedSourceIds.has(example.sourceId)) return `Example ${example.id} references unselected source ${example.sourceId}.`;
    if (example.origin !== "extracted") continue;
    if (!example.sourceTurnId) return `Extracted example ${example.id} must declare sourceTurnId.`;
    const source = evidence.find((item) => item.source.id === example.sourceId);
    const user = source?.excerpts.find((item) => item.role === "user" && item.turnId === example.sourceTurnId);
    const assistant = source?.excerpts.find((item) => item.role === "assistant" && item.turnId === example.sourceTurnId);
    if (!user || user.text !== example.inputPrompt || !assistant || assistant.text !== example.expectedOutputText) return `Extracted example ${example.id} must exactly match its selected user/assistant pair.`;
  }
  if (!proposal.diagnosis.trainingEligible) return null;
  if (!proposal.policy.policyVisibleFields.includes("input.prompt")) return "policyVisibleFields must include input.prompt.";
  if (!proposal.policy.privilegedFields.includes("expectedOutput.text")) return "privilegedFields must include expectedOutput.text.";
  if (proposal.proposedGraders.length === 0) return "Training-eligible proposals must include an evaluation grader.";
  const prefixes = { verifier: "graders/", fixture: "fixtures/", environment: "environment/" } as const;
  for (const file of proposal.generatedFiles) if (!file.path.replaceAll("\\", "/").startsWith(prefixes[file.role])) return `${file.role} file ${file.path} must start with ${prefixes[file.role]}.`;
  const generatedPaths = new Set(proposal.generatedFiles.map((file) => file.path.replaceAll("\\", "/")));
  for (const grader of proposal.proposedGraders) {
    if (grader.kind !== "custom_verifier") continue;
    const module = grader.module.replaceAll("\\", "/");
    if (!module.startsWith("graders/")) return `custom verifier ${grader.id} module must start with graders/.`;
    if (!generatedPaths.has(module)) return `custom verifier ${grader.id} module ${module} must have a matching generated file.`;
  }
  return null;
}

function authoringTimeoutSignal(parent: AbortSignal, timeoutMs: number): {
  signal: AbortSignal;
  timeoutMs: number;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent.reason);
  if (parent.aborted) abortFromParent();
  else parent.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error(`Task authoring timed out after ${timeoutMs}ms.`)),
    timeoutMs,
  );
  timer.unref?.();
  return {
    signal: controller.signal,
    timeoutMs,
    cleanup: () => {
      clearTimeout(timer);
      parent.removeEventListener("abort", abortFromParent);
    },
  };
}

function parseEnvelope(content: string): z.infer<typeof ModelProposalEnvelopeSchema> | null {
  const candidates = [content, content.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "")];
  for (const candidate of candidates) {
    try {
      const parsed = ModelProposalEnvelopeSchema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data;
    } catch {
      // Try the next normalization.
    }
  }
  return null;
}

async function collect(stream: AsyncIterable<{ text?: string }>): Promise<string> {
  let content = "";
  for await (const delta of stream) if (delta.text) content += delta.text;
  return content;
}
