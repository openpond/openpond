import {z} from "zod";

/** Installation-local subscription execution; this pin is never a hosted target. */
export const CodexExperimentRuntimeSchema=z.object({
  providerId:z.literal("codex"),
  configurationHash:z.string().regex(/^[a-f0-9]{64}$/),
  accountHash:z.string().regex(/^[a-f0-9]{64}$/),
  reasoningEffort:z.enum(["low","medium","high","xhigh"]),
  maximumRequestCostUsd:z.number().finite().positive().max(10000),
  requestTimeoutMs:z.number().int().min(1000).max(300000),
}).strict();
export type CodexExperimentRuntime=z.infer<typeof CodexExperimentRuntimeSchema>;
