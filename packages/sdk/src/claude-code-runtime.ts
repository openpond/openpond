import {z} from "zod";
const Hash=z.string().regex(/^[a-f0-9]{64}$/);
export const ClaudeCodeRuntimeSchema=z.object({providerId:z.literal("claude-code"),configurationHash:Hash,executableHash:Hash,version:z.string().regex(/^2\.\d+\.\d+$/),capabilityHash:Hash,maximumRequestCostUsd:z.number().finite().positive().max(10000),requestTimeoutMs:z.number().int().min(1000).max(300000),maximumTurns:z.number().int().min(1).max(100),holdOpen:z.boolean()}).strict();
export type ClaudeCodeRuntime=z.infer<typeof ClaudeCodeRuntimeSchema>;
export const ClaudeCodeControlSchema=z.object({id:z.string().min(1).max(200),receiptId:z.string().min(1).max(200),sessionId:z.uuid(),operationId:z.string().min(1).max(200),action:z.enum(["message","seal"]),text:z.string().max(262144).optional()}).strict().superRefine((value,context)=>{if(value.action==="message"&&!value.text?.trim())context.addIssue({code:"custom",message:"A human intervention requires a message."});if(value.action==="seal"&&value.text!==undefined)context.addIssue({code:"custom",message:"Sealing does not add a prompt."});});
export const ClaudeProcessEvidenceSchema=z.object({
 provider:z.literal("claude-code"),sessionId:z.uuid(),requestId:z.string().min(1).max(200),modelId:z.string().min(1).max(500),
 runtime:ClaudeCodeRuntimeSchema,sourceHash:Hash,outputHash:Hash,traceHash:Hash,
 runtimeEventRefs:z.array(z.string().min(1).max(200)).min(1).max(20000),eventCount:z.number().int().positive().max(20000),
 startedAt:z.iso.datetime(),completedAt:z.iso.datetime(),cleanupComplete:z.literal(true),
}).strict().superRefine((value,context)=>{if(value.runtimeEventRefs.length!==value.eventCount||new Set(value.runtimeEventRefs).size!==value.eventCount)context.addIssue({code:"custom",message:"Process event references must match the exact retained trace population."});});
export type ClaudeProcessEvidence=z.infer<typeof ClaudeProcessEvidenceSchema>;
