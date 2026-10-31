import { spawn } from "node:child_process";
import { once } from "node:events";
import { z } from "zod";
import { ToolLearningLocalStore } from "openpond-sdk/tool-learning/node";
import { captureLocalToolBoundary } from "@openpond/local-server/tool-learning";
import { optionString } from "../common/options";
import { loadToolLearningCredential, toolLearningHome, type ToolLearningOptions } from "./credentials";
import { configureLocalToolLearning, flushToolLearning } from "./delivery";
import { externalCaptureVersion } from "./external-client";

const Command = z.object({ id: z.string().min(1).max(200), type: z.literal("command_execution"), command: z.string().max(32768),
  aggregated_output: z.string(), exit_code: z.number().int().nullable(), status: z.enum(["in_progress", "completed", "failed"]) });

/** Forward Codex's own execution stream. Capture observes real status; it never
 * changes commands, sandbox settings, approvals, or model responses. */
export async function runCodexWithCapture(options: ToolLearningOptions, id: string) {
  const home = toolLearningHome(options), { value: record } = await loadToolLearningCredential(home, id);
  if (record.prepared.registration.client !== "codex" || !record.locallyEnabled || record.installation?.state !== "enabled") throw new Error("Select an enabled Codex capture installation.");
  if (await externalCaptureVersion("codex") !== record.prepared.registration.clientVersion) throw new Error("Codex version changed; run tool-learning doctor.");
  const prompt = optionString(options, "prompt");
  if (!prompt) throw new Error("Use tool-learning run <installation-id> --prompt <task> for a fresh Codex CLI session.");
  const args = ["exec", "--json", "--cd", record.workspaceRoot];
  const model = optionString(options, "model"), sandbox = optionString(options, "sandbox");
  if (model) args.push("--model", model);
  if (sandbox) args.push("--sandbox", z.enum(["read-only", "workspace-write"]).parse(sandbox));
  args.push("--", prompt);
  const store = new ToolLearningLocalStore(home);
  try {
    configureLocalToolLearning(store, record, record.installation);
    const child = spawn("codex", args, { cwd: record.workspaceRoot, stdio: ["inherit", "pipe", "inherit"] });
    const completion = once(child, "close").catch(error => [null, error]);
    const interrupt = () => child.kill("SIGINT");
    const terminate = () => child.kill("SIGTERM");
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    let sessionId: string | null = null, pending = "", oversized = false;
    const observe = async (line: string) => {
      let raw; try { raw = JSON.parse(line); } catch { return; }
      if (raw.type === "thread.started" && typeof raw.thread_id === "string") { sessionId = raw.thread_id; store.recordClientObservation(id, "start"); }
      if (!sessionId || !["item.started", "item.completed"].includes(raw.type)) return;
      const parsed = Command.safeParse(raw.item); if (!parsed.success) return;
      const item = parsed.data, before = raw.type === "item.started";
      store.recordClientObservation(id, before ? "pre_tool" : "post_tool");
      const base = { client: "codex" as const, installationId: id, workspaceRoot: record.workspaceRoot, sessionId, callId: item.id,
        tool: "Bash", clientVersion: record.prepared.registration.clientVersion };
      if (before) await captureLocalToolBoundary(home, { ...base, phase: "attempt", arguments: { command: item.command } });
      else await captureLocalToolBoundary(home, { ...base, phase: "observation", result: {
        outcome: item.exit_code === null ? "incomplete" : item.exit_code === 0 ? "succeeded" : "failed",
        execution: item.exit_code === null ? "unknown" : "executed", sideEffects: "unknown", text: item.aggregated_output,
        exitCode: item.exit_code, classification: "process_failure",
      } });
    };
    try {
      child.stdout.setEncoding("utf8");
      for await (const chunk of child.stdout) {
        if (!process.stdout.write(chunk)) await once(process.stdout, "drain");
        for (const segment of String(chunk).split(/(?<=\n)/u)) {
          if (!oversized) { pending += segment; if (Buffer.byteLength(pending) > 1048576) { pending = ""; oversized = true; store.recordDropped(id); } }
          if (segment.endsWith("\n")) {
            if (!oversized) { try { await observe(pending); } catch { process.stderr.write("Fix-it capture unavailable; run tool-learning doctor.\n"); } }
            pending = ""; oversized = false;
          }
        }
      }
      const [code, signal] = await completion;
      if (signal instanceof Error) throw signal;
      if (code !== 0 || signal) process.exitCode = typeof code === "number" ? code : 1;
      try { await flushToolLearning(home, store, record, AbortSignal.timeout(5000)); } catch { process.stderr.write("Fix-it evidence remains queued; run tool-learning flush.\n"); }
    } finally { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate); if (child.exitCode === null) child.kill("SIGTERM"); }
  } finally { store.close(); }
}
