import { contentHash } from "@openpond/harness";
import { assertBoundedTaskJson } from "@openpond/evals/task-schema";
import { runJavaScriptEnvironmentAttempt, type JavaScriptEnvironmentPolicyMessage } from "@openpond/evals/javascript-environment/attempt";
import { executeJavaScriptEnvironmentInProcess } from "@openpond/evals/javascript-environment/node";
import { ExperimentCaseRequestSchema, type ExperimentModelCase } from "./experiment-case-contract.js";

export type ExperimentCasePolicy = Parameters<typeof runJavaScriptEnvironmentAttempt>[0]["policy"];

/** The app-server owns target/environment execution. Hosts retain admission,
 * spend authority, immutable storage and private grading in existing services. */
export function createExperimentCaseService(deps: {
  resolvePolicy(input: ExperimentModelCase): Promise<ExperimentCasePolicy>;
  resolveEnvironment?(input: ExperimentModelCase): Promise<typeof executeJavaScriptEnvironmentInProcess>;
  executeProfile(request: unknown): Promise<unknown>;
}) {
  const active = new Map<string,{hash:string;controller:AbortController;result:Promise<unknown>}>();
  async function execute(raw: unknown) {
    assertBoundedTaskJson(raw, 8_388_608);
    const input = ExperimentCaseRequestSchema.parse(raw);
    if(input.kind === "profile") return deps.executeProfile(input.request);
    const hash = contentHash(input);
    const existing = active.get(input.id);
    if(existing) {
      if(existing.hash !== hash) throw new Error("Experiment case operation already owns different admitted inputs.");
      return existing.result;
    }
    if(active.size >= 100) throw new Error("Experiment case execution capacity reached.");
    const controller = new AbortController();
    const result = run(input,controller.signal);
    active.set(input.id,{hash,controller,result});
    try { return await result; }
    finally { active.delete(input.id); }
  }
  async function run(input: ExperimentModelCase, parentSignal: AbortSignal) {
    // Resolve the exact admitted model before creating any environment.
    const policy = await deps.resolvePolicy(input);
    const signal = AbortSignal.any([parentSignal,AbortSignal.timeout(input.timeoutMs)]);
    signal.throwIfAborted();
    if(input.environment.kind === "javascript") {
      const execute = deps.resolveEnvironment
        ? await deps.resolveEnvironment(input) : executeJavaScriptEnvironmentInProcess;
      return runJavaScriptEnvironmentAttempt({
        taskId:input.taskId,instructions:`${input.instructions}\n${JSON.stringify({policyVisibleContext:input.policyVisibleContext})}`,input:input.input,
        definition:input.environment.definition,asset:input.environment.asset,
        initialState:input.environment.initialState,seed:input.environment.seed,
        timeoutMs:input.timeoutMs,execute,policy,signal,
      });
    }
    const messages: JavaScriptEnvironmentPolicyMessage[] = [
      {role:"system",text:input.instructions},
      {role:"user",text:JSON.stringify({input:input.input,policyVisibleContext:input.policyVisibleContext})},
    ];
    let output:string|null=null,error:string|null=null;
    let status:"completed"|"cancelled"|"timed_out"|"policy_failure"="completed";
    try {
      const response = await policy({messages,tools:[],signal});
      signal.throwIfAborted();
      if(response.toolCalls.length) throw new Error("Text cases do not support tool calls.");
      output=response.text;messages.push({role:"assistant",text:response.text,toolCalls:[]});
    } catch(cause) {
      error=cause instanceof Error?cause.message:"Experiment policy failed.";
      status=parentSignal.aborted?"cancelled":signal.aborted?"timed_out":"policy_failure";
    }
    const content={schemaVersion:"openpond.javascriptEnvironmentAttempt.v1" as const,taskId:input.taskId,status,
      output,error,messages,collected:status==="completed",environmentCleanupComplete:true,snapshot:null};
    return {...content,contentHash:contentHash(content)};
  }
  return {
    execute,
    cancel(id: string) { const current=active.get(id);current?.controller.abort(new Error("experiment_case_cancelled"));return {id,cancelled:Boolean(current)}; },
    async close() {for(const value of active.values())value.controller.abort(new Error("experiment_runtime_closed"));await Promise.allSettled([...active.values()].map(value=>value.result));},
  };
}
