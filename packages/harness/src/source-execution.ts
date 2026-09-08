import { runProviderRoundLoop } from "./provider-loop.js";
import { HARNESS_SOURCE_READ_TOOL_NAME, type createHarnessSourceRuntime } from "./source-runtime.js";

export type HarnessPolicyMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
};
export type HarnessPolicyToolCall = { id: string; name: string; arguments: string };
export type HarnessEnvironmentStep = {
  toolResults: Array<{ id: string; name: string; output: unknown }>;
  userMessage: string | null;
  terminal: boolean;
};

/** Shared rollout lifecycle. Hosts own model transport, environment effects and
 * grading; this runtime owns released resource calls and conversation history. */
export async function executeHarnessRollout<TPolicyResult, TStep extends HarnessEnvironmentStep>(input: {
  turnId: string;
  maxTurns: number;
  signal: AbortSignal;
  runtime: ReturnType<typeof createHarnessSourceRuntime> | null;
  systemPrompt: string;
  userPrompt: string;
  tools: Array<Record<string, unknown>>;
  policyRequest(request: {
    turnIndex: number;
    messages: HarnessPolicyMessage[];
    tools: Array<Record<string, unknown>>;
  }, signal: AbortSignal): Promise<{
    result: TPolicyResult;
    content: string | null;
    toolCalls: HarnessPolicyToolCall[];
  }>;
  step(request: { content: string | null; toolCalls: HarnessPolicyToolCall[] }, signal: AbortSignal): Promise<TStep>;
  terminate(reason: "max_turns", signal: AbortSignal): Promise<TStep>;
}) {
  const messages: HarnessPolicyMessage[] = [
    { role: "system", content: input.runtime?.systemPrompt ?? input.systemPrompt },
    { role: "user", content: input.userPrompt },
  ];
  const tools = [...input.tools, ...(input.runtime?.tools ?? [])];
  const policyResults: TPolicyResult[] = [];
  const toolSequence: string[] = [];
  const trace: Array<Record<string, unknown>> = [];
  const finalStep = await runProviderRoundLoop<TStep>({
    turnId: input.turnId,
    maxRounds: input.maxTurns,
    signal: input.signal,
    async runRound({ index: turnIndex, signal }) {
      // Transport receives owned messages so a host cannot mutate retained history.
      const completion = await input.policyRequest({ turnIndex, messages: structuredClone(messages), tools: structuredClone(tools) }, signal);
      signal.throwIfAborted();
      policyResults.push(completion.result);
      messages.push({ role: "assistant", content: completion.content,
        tool_calls: completion.toolCalls.map(call => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) });
      const sourceCalls = input.runtime ? completion.toolCalls.filter(call => call.name === HARNESS_SOURCE_READ_TOOL_NAME) : [];
      const environmentCalls = input.runtime ? completion.toolCalls.filter(call => call.name !== HARNESS_SOURCE_READ_TOOL_NAME) : completion.toolCalls;
      const sourceResults = sourceCalls.map(call => {
        let output: unknown;
        try { output = input.runtime!.readFile(JSON.parse(call.arguments)); }
        catch (error) { output = { error: error instanceof Error ? error.message : "Harness source read failed." }; }
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output) });
        toolSequence.push(call.name);
        return { id: call.id, name: call.name, output };
      });
      if (sourceCalls.length && !environmentCalls.length) {
        trace.push({ turnIndex, content: completion.content, toolCalls: sourceCalls, toolResults: sourceResults, terminal: false });
        return { type: "continue" };
      }
      const step = await input.step({ content: completion.content, toolCalls: environmentCalls }, signal);
      signal.throwIfAborted();
      for (const result of step.toolResults) {
        messages.push({ role: "tool", tool_call_id: result.id, content: JSON.stringify(result.output) });
        toolSequence.push(result.name);
      }
      if (step.userMessage) messages.push({ role: "user", content: step.userMessage });
      trace.push({ turnIndex, content: completion.content, toolCalls: completion.toolCalls,
        toolResults: [...sourceResults, ...step.toolResults], terminal: step.terminal });
      return step.terminal ? { type: "complete", result: step } : { type: "continue" };
    },
    async onExhausted() {
      input.signal.throwIfAborted();
      const step = await input.terminate("max_turns", input.signal);
      if (!step.terminal) throw new Error("Harness environment did not terminate after exhausting its turn budget.");
      trace.push({ turnIndex: input.maxTurns, content: null, toolCalls: [], toolResults: [], terminal: true, terminationReason: "max_turns" });
      return step;
    },
  });
  return { messages, toolSequence, trace, policyResults, finalStep, runtimeReceipt: input.runtime?.receipt ?? null };
}
