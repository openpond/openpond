import { z } from "zod";
import { contentHash } from "@openpond/harness";

const count = z.number().int().nonnegative().nullable();
export const ConnectedInvocationSchema = z.object({ requestId: z.string().min(1), startedAt: z.string().datetime(),
  provider: z.string(), model: z.string(), mode: z.string(), status: z.string(), source: z.string(), projectId: z.string().nullable(),
  inputTokens: count, cachedInputTokens: count, outputTokens: count, totalTokens: count }).strict();
export type ConnectedInvocation = z.infer<typeof ConnectedInvocationSchema>;
const empty = () => ({ invocations: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0,
  missingInput: 0, missingCachedInput: 0, missingOutput: 0, missingTotal: 0, failures: 0, unattributed: 0 });
export type ConnectedUsageTotals = ReturnType<typeof empty>;
const nonnegative = z.number().int().nonnegative();
export const ConnectedUsageTotalsSchema = z.object({ invocations: nonnegative, inputTokens: nonnegative, cachedInputTokens: nonnegative,
  outputTokens: nonnegative, totalTokens: nonnegative, missingInput: nonnegative, missingCachedInput: nonnegative,
  missingOutput: nonnegative, missingTotal: nonnegative, failures: nonnegative, unattributed: nonnegative }).strict();
export const ConnectedUsageSummarySchema = z.object({ total: ConnectedUsageTotalsSchema,
  days: z.array(ConnectedUsageTotalsSchema.extend({ key: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })),
  modes: z.array(ConnectedUsageTotalsSchema.extend({ key: z.string() })), models: z.array(ConnectedUsageTotalsSchema.extend({ key: z.string() })) }).strict();
function add(total: ConnectedUsageTotals, row: ConnectedInvocation) {
  total.invocations++; total.failures += row.status === "completed" ? 0 : 1; total.unattributed += row.projectId === null ? 1 : 0;
  for (const [value, missing] of [["inputTokens", "missingInput"], ["cachedInputTokens", "missingCachedInput"], ["outputTokens", "missingOutput"], ["totalTokens", "missingTotal"]] as const) {
    const measured = row[value]; if (measured === null) total[missing]++; else total[value] += measured;
    if (!Number.isSafeInteger(total[value])) throw new Error("connected_usage_sum_overflow");
  }
}
/** A billed retry has a new invocation identity; repeated copies of one receipt do not add spend.
 * Unknown token fields remain unknown and are never inferred from another field.
 */
export function summarizeConnectedInvocations(raw: unknown[]) {
  const unique = new Map<string, ConnectedInvocation>();
  for (const value of raw) {
    const row = ConnectedInvocationSchema.parse(value), prior = unique.get(row.requestId);
    if (prior && contentHash(prior) !== contentHash(row)) throw new Error("connected_usage_receipt_conflict");
    unique.set(row.requestId, row);
  }
  const total = empty(), days = new Map<string, ConnectedUsageTotals>(), modes = new Map<string, ConnectedUsageTotals>(), models = new Map<string, ConnectedUsageTotals>();
  for (const row of unique.values()) {
    add(total, row);
    for (const [map, key] of [[days, row.startedAt.slice(0, 10)], [modes, row.mode], [models, `${row.provider}/${row.model}`]] as const) {
      const aggregate = map.get(key) ?? empty(); add(aggregate, row); map.set(key, aggregate);
    }
  }
  const entries = (map: Map<string, ConnectedUsageTotals>) => [...map].sort(([a], [b]) => a.localeCompare(b)).map(([key, totals]) => ({ key, ...totals }));
  return { total, days: entries(days), modes: entries(modes), models: entries(models) };
}
