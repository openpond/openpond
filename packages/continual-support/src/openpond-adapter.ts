import type { ContinualBenchRunnerAdapter } from "./adapter.js";
import { assertOptimizerIsolation } from "./releases.js";
import type { ContinualBenchPortableReport } from "./report.js";
import { validateContinualBenchManifest } from "./validation.js";

export type OpenPondContinualBenchContext = {
  baseUrl: string;
  request: typeof fetch;
  series: Record<string, unknown>;
  loadReport: (seriesId: string) => Promise<ContinualBenchPortableReport>;
};

export function createOpenPondContinualBenchAdapter(): ContinualBenchRunnerAdapter<OpenPondContinualBenchContext> {
  return {
    id: "openpond",
    async validate(manifest, context) {
      const local = validateContinualBenchManifest(manifest);
      const issues = local.issues.map((issue) => ({ code: issue.code, message: issue.message, path: issue.path }));
      const protocol = record(context.series.benchmarkProtocol);
      const ledger = record(protocol.issueFamilyLedger);
      if (ledger.contentHash !== manifest.contentHash) {
        issues.push({ code: "manifest_binding", message: "The OpenPond protocol issue-family ledger must bind the exact portable manifest hash.", path: "execution.series.benchmarkProtocol.issueFamilyLedger.contentHash" });
      }
      return { valid: local.valid && issues.length === 0, issues };
    },
    async run(manifest, context) {
      const validation = await this.validate(manifest, context);
      if (!validation.valid) throw new Error(validation.issues.map((issue) => `${issue.code}: ${issue.message}`).join("\n"));
      assertOptimizerIsolation(manifest);
      const saved = record(await json(context.request, `${trimSlash(context.baseUrl)}/v1/training/comparison-series`, "POST", { series: context.series }));
      const seriesId = text(saved.id) ?? text(context.series.id);
      const revision = integer(saved.revision);
      if (!seriesId || !revision) throw new Error("OpenPond did not return the saved Comparison Series identity and revision.");
      await json(context.request, `${trimSlash(context.baseUrl)}/v1/training/comparison-series/${encodeURIComponent(seriesId)}/seal`, "POST", { expectedRevision: revision });
      return { comparisonSeriesId: seriesId, canonicalUrl: `/models/runs/series/${encodeURIComponent(seriesId)}`, protocolHash: manifest.contentHash };
    },
    report(seriesId, context) {
      return context.loadReport(seriesId);
    },
  };
}

async function json(request: typeof fetch, url: string, method: "POST", body: unknown): Promise<unknown> {
  const response = await request(url, { method, headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const source = await response.text();
  const payload: unknown = source ? JSON.parse(source) : null;
  if (!response.ok) throw new Error(`OpenPond adapter request failed (${response.status}): ${text(record(payload).error) ?? response.statusText}`);
  return payload;
}

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function integer(value: unknown): number | null { return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null; }
function trimSlash(value: string): string { return value.replace(/\/$/, ""); }
