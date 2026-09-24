import type { SizeSnapshot } from "./size-snapshot.ts";

const KiB = 1024;
// Warn only when both the absolute and proportional growth are meaningful.
// These are advisory; broad ceilings and runtime checks enforce the hard limits.
const metrics = [
  { key: "packed", label: "npm tarball", bytes: 256 * KiB, ratio: 0.05 },
  { key: "unpacked", label: "npm unpacked", bytes: 1024 * KiB, ratio: 0.05 },
  { key: "rendererJs", label: "All renderer JavaScript (raw)", bytes: 512 * KiB, ratio: 0.05 },
  { key: "initialAssets", label: "HTML entry assets (raw)", bytes: 64 * KiB, ratio: 0.10 },
] as const;

export function compareSizes(head: SizeSnapshot, base?: SizeSnapshot) {
  if (base && (base.nodeVersion !== head.nodeVersion || base.npmVersion !== head.npmVersion)) {
    throw new Error("Size comparison requires the same Node and npm versions for base and head.");
  }
  const warnings: string[] = [];
  const lines = ["## Package size", "", `Build: ${head.revision}`, ""];
  if (base) lines.push(`Base: ${base.revision}`, "");
  else lines.push("No base comparison for this build. PR comparisons appear in the Package size comparison job.", "");
  lines.push("| Metric | Base | Current | Change |", "| --- | ---: | ---: | ---: |");
  for (const metric of metrics) {
    const current = head.metrics[metric.key];
    const before = base?.metrics[metric.key];
    const delta = before === undefined ? undefined : current - before;
    lines.push(`| ${metric.label} | ${before === undefined ? "—" : formatBytes(before)} | ${formatBytes(current)} | ${delta === undefined ? "—" : formatDelta(delta)} |`);
    if (before !== undefined && delta! >= metric.bytes && delta! >= before * metric.ratio) {
      warnings.push(`${metric.label} grew by ${formatBytes(delta!)} (${before ? (delta! / before * 100).toFixed(1) + "%" : "new payload"}). Inspect the size report before merging.`);
    }
  }
  if (warnings.length) lines.push("", ...warnings.map((warning) => `- ${warning}`));
  if (base) {
    const changes = assetChanges(head, base).filter((file) => file.delta > 0).slice(0, 15);
    lines.push("", "### Largest growth contributors", "", "| Asset / group | Raw growth | Individual gzip growth |", "| --- | ---: | ---: |");
    for (const file of changes) lines.push(`| ${escapeCell(file.path)} | ${formatDelta(file.delta)} | ${formatDelta(file.gzipDelta)} |`);
    if (!changes.length) lines.push("| No asset growth | 0 B | 0 B |");
  }
  lines.push("", "### Largest current files", "", "| File | Raw | Individual gzip |", "| --- | ---: | ---: |");
  for (const file of [...head.files].sort((a, b) => b.size - a.size).slice(0, 10)) {
    lines.push(`| ${escapeCell(file.path)} | ${formatBytes(file.size)} | ${formatBytes(file.gzip)} |`);
  }
  lines.push("", "Content hashes are removed for asset comparisons; anonymous runtime chunks are grouped to avoid misleading churn when code is split differently. Individual gzip sizes explain contributors but do not sum to the npm tarball size. HTML entry assets match the existing loading budget; they exclude dynamically loaded screens and workers.", "");
  return { markdown: lines.join("\n"), warnings };
}

export function assetChanges(head: SizeSnapshot, base: SizeSnapshot) {
  const previous = groupedAssets(base);
  const current = groupedAssets(head);
  return [...new Set([...previous.keys(), ...current.keys()])].map((name) => ({
    path: name,
    delta: (current.get(name)?.size ?? 0) - (previous.get(name)?.size ?? 0),
    gzipDelta: (current.get(name)?.gzip ?? 0) - (previous.get(name)?.gzip ?? 0),
  })).sort((a, b) => b.delta - a.delta || a.path.localeCompare(b.path));
}

function groupedAssets(snapshot: SizeSnapshot) {
  const groups = new Map<string, { size: number; gzip: number }>();
  for (const file of snapshot.files) {
    const name = file.path.startsWith("dist/chunks/") ? "dist/chunks/* (shared runtime)"
      : file.path.replace(/-[\w-]{8}(?=\.[^.]+$)/, "-[hash]");
    const group = groups.get(name) ?? { size: 0, gzip: 0 };
    group.size += file.size;
    group.gzip += file.gzip;
    groups.set(name, group);
  }
  return groups;
}

function escapeCell(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("|", "&#124;").replace(/[\r\n]/g, " ");
}
function formatBytes(bytes: number) {
  return Math.abs(bytes) >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MiB`
    : Math.abs(bytes) >= 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${bytes} B`;
}
function formatDelta(bytes: number) { return `${bytes > 0 ? "+" : ""}${formatBytes(bytes)}`; }
