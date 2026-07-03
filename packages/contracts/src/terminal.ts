import { z } from "zod";

export const TerminalScopeSchema = z.object({
  kind: z.enum(["session", "project", "draft"]),
  id: z.string().trim().min(1).max(300),
});

export type TerminalScope = z.infer<typeof TerminalScopeSchema>;

export const TerminalCommandStatusSchema = z.enum(["unknown", "idle", "running", "success", "failed"]);
export type TerminalCommandStatus = z.infer<typeof TerminalCommandStatusSchema>;

export const TerminalScopeSummaryStatusSchema = z.enum([
  "none",
  "idle",
  "running",
  "success",
  "failed",
  "unknown",
]);
export type TerminalScopeSummaryStatus = z.infer<typeof TerminalScopeSummaryStatusSchema>;
