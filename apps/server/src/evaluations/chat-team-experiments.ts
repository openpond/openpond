import { z } from "zod";
import type { ChatResourceSummary, LocalExperimentRecord, LocalExperimentResult } from "@openpond/contracts";
import type { createLocalExperimentService } from "./local-experiment-service.js";
import { chatExperimentSummary, localExperimentView } from "./chat-experiments.js";

/** Association is separate from execution authority. The existing team owner
 * validates every read, including reads made after a successful CLI command. */
export function createChatTeamExperiments(deps: {
  service: Pick<ReturnType<typeof createLocalExperimentService>, "request" | "read" | "result">;
  resolveInvocation(token: string): Promise<{sessionId:string;turnId:string}>;
  attach(context: {sessionId:string;turnId:string}, resources: ChatResourceSummary[]): Promise<void>;
}) {
  async function inspect(owner: {teamId:string;actorId:string}, id: string) {
    const record = await deps.service.read({teamId:owner.teamId,id});
    if (record.ownerActorId !== owner.actorId) throw new Error("Experiment owner changed. Reopen it from its owning workspace.");
    const evidence = await deps.service.result({teamId:owner.teamId,id});
    return {summary: summary(record,evidence), inputs:inputs(record), evidence, view: localExperimentView(evidence)};
  }
  function summary(record: LocalExperimentRecord, evidence: LocalExperimentResult): ChatResourceSummary {
    return {...chatExperimentSummary(record,evidence), owner:{teamId:record.teamId,actorId:record.ownerActorId}, contentHash:record.configurationHash};
  }
  function inputs(record: LocalExperimentRecord): ChatResourceSummary[] {
    const owner = {teamId:record.teamId,actorId:record.ownerActorId};
    const pin = record.configuration.request.taskset;
    return [{kind:"dataset",id:pin.id,revision:pin.revision,name:pin.id,state:"Pinned",owner,contentHash:pin.contentHash,
      taskCount:record.configuration.request.population.length,graderCount:record.graders.length,rows:[]},
      ...record.graders.map(grader => ({kind:"grader" as const,id:`grader-${grader.contentHash.slice(0,40)}`,revision:1,
        name:grader.name ?? grader.id,state:"Pinned",owner,contentHash:grader.contentHash,graderId:grader.id,
        description:`Version ${grader.version}`,datasetId:pin.id,datasetRevision:pin.revision,rows:[]}))];
  }
  async function request(raw: unknown) {
    const envelope = z.object({invocationToken:z.string().optional()}).passthrough().parse(raw);
    const {invocationToken,...command} = envelope;
    const context = invocationToken ? await deps.resolveInvocation(invocationToken) : null;
    const result = await deps.service.request(command);
    // Listing and preparation are discovery; they must not select every row.
    if (!context || !["run","runFromRelease","read","get","status","cancel","result"].includes(String(command.action))) return result;
    const object = result && typeof result === "object" ? result as Record<string,unknown> : {};
    const execution = object.execution && typeof object.execution === "object" ? object.execution as Record<string,unknown> : object;
    if (execution.kind !== "target" || typeof execution.id !== "string" || typeof command.teamId !== "string") return result;
    const record = await deps.service.read({teamId:command.teamId,id:execution.id});
    const evidence = await deps.service.result({teamId:command.teamId,id:record.id});
    await deps.attach(context,[...inputs(record),summary(record,evidence)]);
    // Preserve the CLI's canonical response; attachment is server-owned state.
    return result;
  }
  return {request,inspect};
}
