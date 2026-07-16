import { defineIntent, defineWorkflow, type AgentChatInput } from "openpond-agent-sdk";
import { z } from "zod";

const EstimateReviewInput = z.object({
  prompt: z.string(),
  files: z.array(z.object({ ref: z.string() })).default([]),
  context: z.record(z.string(), z.unknown()).optional(),
});

export const generateEstimateReviewWorkflow = defineWorkflow({
  name: "generate-estimate-review",
  description: "Import historical estimate files, review a proposal, and export an estimate package.",
  async run(ctx, input) {
    ctx.trace.event("estimate_review.started");
    await ctx.runCommand("pnpm generate-estimate", { input });
    ctx.trace.artifact("artifacts/example-estimate.json");
    ctx.trace.artifact("artifacts/example-estimate.xlsx");
    ctx.trace.artifact("artifacts/proposal-review.json");

    return {
      text: "OpenPond generated the water estimate review and exported the estimate package.",
      intent: "generate_estimate_review",
      artifactRefs: [
        "artifacts/example-estimate.json",
        "artifacts/example-estimate.csv",
        "artifacts/example-estimate.xlsx",
        "artifacts/search-results.json",
        "artifacts/proposal-review.json",
        "artifacts/sqlite-import-summary.json",
      ],
    };
  },
});

export const generateEstimateReviewIntent = defineIntent<AgentChatInput>({
  name: "generate_estimate_review",
  description: "Review proposal/history files and generate a water estimate package.",
  inputSchema: EstimateReviewInput,
  when(input) {
    const text = `${input.prompt} ${JSON.stringify(input.context ?? {})}`.toLowerCase();
    return (
      text.includes("estimate") ||
      text.includes("proposal") ||
      text.includes("history") ||
      (input.files ?? []).some((file) => /\.(xlsx|xls|csv)$/i.test(file.name ?? file.ref))
    );
  },
  async run(ctx, input) {
    return ctx.workflow("generate-estimate-review", input);
  },
});
