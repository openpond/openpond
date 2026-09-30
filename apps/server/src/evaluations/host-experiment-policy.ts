import { createHash } from "node:crypto";
import { z } from "zod";
import type { AgentHostStorageClient } from "@openpond/agent-runtime";
import { HOST_STORAGE_CONTRACT_VERSION } from "@openpond/agent-runtime";
import type { ExperimentModelCase } from "./experiment-case-contract.js";
import type { ExperimentCasePolicy } from "./experiment-case-service.js";

const Response=z.object({text:z.string().max(262_144),toolCalls:z.array(z.object({
  id:z.string().min(1).max(200),name:z.string().min(1).max(64),arguments:z.record(z.string(),z.unknown()),
}).strict()).max(200)}).strict();

/** The owner host resolves credentials, capabilities and whole-run spend.
 * Child requests cannot select another model, workspace or budget authority. */
export function createHostExperimentPolicy(client:AgentHostStorageClient,request:ExperimentModelCase):ExperimentCasePolicy {
  let ordinal=0;
  return async ({messages,tools,signal}) => {
    signal.throwIfAborted();
    const call=ordinal++;
    const result=await client.request({contractVersion:HOST_STORAGE_CONTRACT_VERSION,
      requestId:`experiment-${createHash("sha256").update(request.id).digest("hex")}-${call}`,operation:"experiment/policy",
      params:{caseId:request.id,admissionHash:request.admissionHash,ordinal:call,
        messages:messages.map(value=>({...value})),tools:tools.map(value=>({...value})),
      },
    },Math.min(request.timeoutMs,300_000));
    signal.throwIfAborted();
    return Response.parse(result);
  };
}
