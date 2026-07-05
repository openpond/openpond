import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  action,
  defineAgentProject,
  defineWorkflow,
  schedule,
} from "openpond-agent-sdk";

const OUTPUT_PATH = "artifacts/local-cron-writes.log";
const AGENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const writeTickWorkflow = defineWorkflow({
  name: "write-tick",
  description: "Append a local scheduler heartbeat to a workspace file.",
  async run(_ctx, input) {
    const outputPath = typeof input.outputPath === "string" && input.outputPath.trim()
      ? input.outputPath.trim()
      : OUTPUT_PATH;
    const absoluteOutputPath = path.resolve(AGENT_ROOT, outputPath);
    await mkdir(path.dirname(absoluteOutputPath), { recursive: true });
    const ranAt = new Date().toISOString();
    const line = {
      ranAt,
      prompt: typeof input.prompt === "string" ? input.prompt : "",
      channel: typeof input.channel === "string" ? input.channel : "schedule",
      context: input.context && typeof input.context === "object" ? input.context : {},
    };
    await appendFile(absoluteOutputPath, `${JSON.stringify(line)}\n`, "utf8");
    return {
      text: `Wrote local schedule heartbeat to ${outputPath}.`,
      intent: "write-schedule-tick",
      metadata: {
        outputPath,
        ranAt,
      },
    };
  },
});

export default defineAgentProject({
  name: "local-schedule-writer-agent",
  version: "0.1.0",
  useCase: "local-scheduler-validation",
  description: "Writes a timestamped heartbeat file from a local in-process schedule.",
  manifestMode: "typescript",
  runtime: { base: "node-bun-workspace" },
  defaultAction: "write-tick",
  actions: [
    action("write-tick", {
      label: "Write Tick",
      description: "Append a timestamped heartbeat to artifacts/local-cron-writes.log.",
      target: { kind: "workflow", workflow: writeTickWorkflow },
      timeoutSeconds: 30,
      outputArtifacts: [OUTPUT_PATH],
      schedule: { enabled: true, allowAdHoc: true },
    }),
  ],
  workflows: [writeTickWorkflow],
  schedules: [
    schedule.rate("write-heartbeat-every-five-minutes", {
      rate: "5 minutes",
      enabledByDefault: true,
      target: { action: "write-tick" },
      input: {
        prompt: "Write a local schedule heartbeat.",
        channel: "schedule",
        context: {
          outputPath: OUTPUT_PATH,
          purpose: "local-scheduler-validation",
        },
      },
    }),
  ],
});
