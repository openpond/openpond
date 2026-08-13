import { defineAction } from "openpond-sdk/actions";
import { z } from "zod";

import { getAnalyticsSummary } from "../../packages/domain/analytics.js";

export const getAnalytics = defineAction("analytics.get_summary", {
  description: "Get the current operating summary for one line of business.",
  input: z.object({ businessId: z.string().min(1) }),
  output: z.object({
    businessId: z.string(),
    activeMoves: z.number().int().nonnegative(),
    bookedRevenueUsd: z.number().nonnegative(),
  }),
  run(context, input) {
    const summary = getAnalyticsSummary(input.businessId);
    context.trace("analytics.loaded", { businessId: input.businessId });
    return summary;
  },
});
