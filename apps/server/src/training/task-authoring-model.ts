import { z } from "zod";
import {
  TaskDesignProposalSchema,
  type ChatModelRef,
  type CodexReasoningEffort,
  type AuthoringRepair,
  type TaskDesignProposal,
  type TrainingSourceRef,
} from "@openpond/contracts";

const ModelProposalEnvelopeSchema = z.object({
  schemaVersion: z.literal("openpond.taskAuthoringDecision.v1"),
  proposal: TaskDesignProposalSchema,
});

const DEFAULT_TASK_AUTHORING_TIMEOUT_MS = 90_000;

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
  methodHint?: string | null;
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
    if (parsed) return { proposal: parsed.proposal, repairHistory: [] };
    const repaired = await collect(input.stream({
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      signal: timeout.signal,
      messages: [...messages, { role: "user", content: `The prior response was invalid. Return only valid JSON matching openpond.taskAuthoringDecision.v1. Invalid response:\n${first.slice(0, 20_000)}` }],
    }));
    const repairedParsed = parseEnvelope(repaired);
    if (!repairedParsed) throw new Error("Task authoring model returned invalid structured output after one repair attempt.");
    return { proposal: repairedParsed.proposal, repairHistory: [{ attempt: 1, summary: "Repaired invalid structured TaskDesignProposal output.", createdAt: new Date().toISOString() }] };
  } catch (error) {
    if (timeout.signal.aborted && !input.signal.aborted) {
      throw new Error(`Task authoring timed out after ${timeout.timeoutMs}ms.`);
    }
    throw error;
  } finally {
    timeout.cleanup();
  }
}

function taskAuthoringMessages(input: { id: string; evidence: TaskAuthoringEvidence[]; skillText: string; methodHint?: string | null; instruction?: string | null; currentProposal?: TaskDesignProposal | null }): Array<{ role: "system" | "user"; content: string }> {
  return [
    {
      role: "system",
      content: [
        "You are OpenPond Taskset Authoring.",
        "Use only the consented evidence supplied below.",
        "Produce one provider-neutral task design. Separate policy-visible input from privileged outcomes.",
        "Prefer deterministic graders. Model judges must be calibrated and cannot silently become reward.",
        "Do not fabricate expert approval, preferences, corrections, or rewards.",
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
