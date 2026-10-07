import type { AcpObject } from "./types.js";
const record = (value: unknown): AcpObject => value && typeof value === "object" && !Array.isArray(value) ? value as AcpObject : {};
const count = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;

/** Turn-local observations; cumulative modelUsage is used only for model limits. */
export class ClaudeObservations {
  private tools = new Map<string, AcpObject>();
  private models = new Set<string>();
  private latestUsage: AcpObject = {};
  private latestModel = "unknown";
  private compacting = false;
  constructor(private readonly emit: (update: AcpObject) => void, private readonly contextWindows = new Map<string, number>()) {}

  tool(update: AcpObject) {
    const id = String(update.toolCallId);
    const previous = this.tools.get(id) ?? {};
    const next = { ...previous, ...update };
    this.tools.set(id, next);
    this.emit(next);
  }
  observe(message: AcpObject) {
    if (message.parent_tool_use_id) return;
    if (message.type === "stream_event") {
      const event = record(message.event), assistant = record(event.message);
      if (event.type === "message_start") this.assistant(assistant, true);
      if (event.type === "message_delta") { this.latestUsage = { ...this.latestUsage, ...record(event.usage) }; this.context(); }
    }
    if (message.type === "assistant") {
      this.assistant(record(message.message), false);
      const report = record(message.context_usage);
      const used = count(report.total_tokens), limit = count(report.raw_max_tokens);
      if (used !== null && limit && typeof report.model === "string") {
        this.contextWindows.set(report.model, limit);
        this.emit({ sessionUpdate: "context_usage", model: report.model, usedTokens: used, maxContextTokens: limit });
      }
    }
    if (message.type === "system" && message.subtype === "status" && message.status === "compacting" && !this.compacting) {
      this.compacting = true;
      this.emit({ sessionUpdate: "compaction_started" });
    }
    if (message.type === "system" && message.subtype === "compact_boundary") {
      this.compacting = false;
      this.latestUsage = {};
      const metadata = record(message.compact_metadata);
      this.emit({ sessionUpdate: "compaction_completed", reason: metadata.trigger, preTokens: metadata.pre_tokens });
    }
  }
  private assistant(message: AcpObject, reset: boolean) {
    if (typeof message.model === "string" && !message.model.startsWith("<")) {
      this.latestModel = message.model;
      this.models.add(message.model);
    }
    // Assistant snapshots may repeat one request across blocks. Never sum them.
    const usage = record(message.usage);
    if (reset) this.latestUsage = usage;
    else this.latestUsage = { ...this.latestUsage, ...usage, output_tokens: Math.max(count(this.latestUsage.output_tokens) ?? 0, count(usage.output_tokens) ?? 0) };
  }
  result(message: AcpObject, cancelled: boolean) {
    this.finishCompaction();
    this.emit({ sessionUpdate: "usage_update", usage: message.usage,
      model: this.models.size > 1 ? "Claude Code (multiple models)" : this.latestModel,
      status: cancelled ? "interrupted" : message.is_error ? "failed" : "completed",
      // Cost and per-model usage are cumulative across resumed sessions, so they
      // are deliberately excluded from the per-turn usage record.
      scope: "main_loop_turn" });
    for (const [model, value] of Object.entries(record(message.modelUsage))) {
      const limit = count(record(value).contextWindow);
      if (limit) this.contextWindows.set(model, limit);
    }
    this.context();
  }
  private context() {
    const limit = this.contextWindows.get(this.latestModel);
    const input = count(this.latestUsage.input_tokens);
    if (limit && input !== null) {
      const used = input + (count(this.latestUsage.cache_read_input_tokens) ?? 0) + (count(this.latestUsage.cache_creation_input_tokens) ?? 0) + (count(this.latestUsage.output_tokens) ?? 0);
      this.emit({ sessionUpdate: "context_usage", model: this.latestModel, usedTokens: used, maxContextTokens: limit });
    }
  }
  finishCompaction() {
    if (!this.compacting) return;
    this.compacting = false;
    this.emit({ sessionUpdate: "compaction_failed", error: "Claude ended before confirming compaction completed." });
  }
}
