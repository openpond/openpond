import { promises as fs } from "node:fs";
import path from "node:path";
import { listPlainWorkspaceFiles, runWorkspaceCommand } from "../workspace/workspaces.js";
import { listWorkspaceFiles, resolveForRead } from "../workspace-tools/workspace-tool-file-system.js";
import type { ResourceSearchRequest, ResourceSearchResult } from "./resources.js";

type WorkspaceSearchMode = "exact" | "path" | "ranked";

type SearchItem = ResourceSearchResult["items"][number];

type TextSample = {
  text: string;
  truncated: boolean;
};

type ExactTextMatch = {
  line: number;
  text: string;
};

type RipgrepMatch = ExactTextMatch & {
  filePath: string;
};

type RankedDocument = {
  content: string;
  filePath: string;
  length: number;
  pathTermCounts: Map<string, number>;
  termCounts: Map<string, number>;
};

type RankedCandidate = {
  document: RankedDocument;
  matchedTerms: string[];
  score: number;
};

type WorkspaceSearchItemsResult = {
  items: SearchItem[];
  truncated: boolean;
};

const DEFAULT_RESOURCE_SEARCH_LIMIT = 20;
const MAX_RESOURCE_SEARCH_LIMIT = 100;
const WORKSPACE_SEARCH_MAX_BYTES = 120_000;
const PATH_TERM_WEIGHT = 4;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".avif",
  ".db",
  ".gif",
  ".gz",
  ".ico",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp4",
  ".pdf",
  ".png",
  ".sqlite",
  ".tar",
  ".webp",
  ".xls",
  ".xlsm",
  ".xlsx",
  ".zip",
]);

export async function searchLocalWorkspaceResources(input: {
  repoPath: string;
  request: ResourceSearchRequest;
}): Promise<ResourceSearchResult> {
  if (input.request.scope !== "workspace") {
    throw new Error(`Unsupported resource search scope: ${input.request.scope}`);
  }
  const query = input.request.query.trim();
  if (!query) throw new Error("Resource search query is required");

  const limit = normalizeLimit(input.request.limit, DEFAULT_RESOURCE_SEARCH_LIMIT, MAX_RESOURCE_SEARCH_LIMIT);
  const mode = workspaceSearchMode(input.request.filters);
  const files = await visibleWorkspaceFiles(input.repoPath);
  const pathQuery = workspaceRelativePathQuery(input.repoPath, query);
  const result = await searchWorkspaceResourcesByMode(input.repoPath, files, query, pathQuery, mode, limit);

  return {
    query,
    scope: input.request.scope,
    items: result.items,
    truncated: result.truncated,
  };
}

async function searchWorkspaceResourcesByMode(
  repoPath: string,
  files: string[],
  query: string,
  pathQuery: string,
  mode: WorkspaceSearchMode,
  limit: number,
): Promise<WorkspaceSearchItemsResult> {
  if (mode === "path") return pathSearchItems(files, pathQuery, limit);
  if (mode === "ranked") return rankedSearchItems(repoPath, files, pathQuery, limit);
  return exactSearchItems(repoPath, files, query, pathQuery, limit);
}

async function exactSearchItems(
  repoPath: string,
  files: string[],
  query: string,
  pathQuery: string,
  limit: number,
): Promise<WorkspaceSearchItemsResult> {
  const items = new Map<string, SearchItem>();
  const lowerQuery = query.toLowerCase();
  const lowerPathQuery = pathQuery.toLowerCase();

  for (const filePath of files) {
    if (filePath.toLowerCase().includes(lowerPathQuery)) {
      addSearchItem(items, {
        ref: workspaceFileRef(filePath),
        title: filePath,
        snippet: "Path match",
        score: 1,
        metadata: {
          source: "workspace",
          matchKind: "path",
          searchMode: "exact",
          path: filePath,
        },
      });
    }
    if (items.size > limit) return finalizeSearchItems([...items.values()], limit);
  }
  if (items.size > limit) {
    return finalizeSearchItems([...items.values()], limit);
  }

  const ripgrepResult = await exactRipgrepItems(repoPath, files, query, limit, items);
  if (ripgrepResult) return ripgrepResult;

  for (const filePath of files) {
    const sample = await readWorkspaceSearchText(repoPath, filePath);
    if (!sample) continue;
    const match = exactTextMatch(sample.text, lowerQuery);
    if (!match) continue;
    addSearchItem(items, {
      ref: workspaceFileRef(filePath),
      title: filePath,
      snippet: `${match.line}: ${match.text}`,
      score: 0.9,
      metadata: {
        source: "workspace",
        matchKind: "text",
        searchMode: "exact",
        path: filePath,
        line: match.line,
        truncated: sample.truncated,
      },
    });
    if (items.size > limit) return finalizeSearchItems([...items.values()], limit);
  }

  return finalizeSearchItems([...items.values()], limit);
}

async function exactRipgrepItems(
  repoPath: string,
  files: string[],
  query: string,
  limit: number,
  pathItems: Map<string, SearchItem>,
): Promise<WorkspaceSearchItemsResult | null> {
  if (query.includes("\n") || query.includes("\r")) return null;
  const result = await runWorkspaceCommand(
    "rg",
    [
      "--json",
      "--fixed-strings",
      "--ignore-case",
      "--max-count",
      "1",
      "--max-filesize",
      String(WORKSPACE_SEARCH_MAX_BYTES),
      "--",
      query,
    ],
    repoPath,
  );
  if (result.code !== 0) return null;

  const visible = new Set(files);
  const items = new Map(pathItems);
  for (const match of parseRipgrepMatches(result.stdout)) {
    if (!visible.has(match.filePath)) continue;
    addSearchItem(items, {
      ref: workspaceFileRef(match.filePath),
      title: match.filePath,
      snippet: `${match.line}: ${match.text}`,
      score: 0.9,
      metadata: {
        source: "workspace",
        matchKind: "text",
        searchMode: "exact",
        searchBackend: "rg",
        path: match.filePath,
        line: match.line,
      },
    });
  }

  return {
    items: [...items.values()].sort(compareSearchItems).slice(0, limit),
    truncated: items.size > limit,
  };
}

function parseRipgrepMatches(output: string): RipgrepMatch[] {
  const matches: RipgrepMatch[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let payload: unknown;
    try {
      payload = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!payload || typeof payload !== "object") continue;
    const record = payload as {
      type?: unknown;
      data?: {
        path?: { text?: unknown };
        line_number?: unknown;
        lines?: { text?: unknown };
      };
    };
    if (record.type !== "match") continue;
    const filePath = typeof record.data?.path?.text === "string" ? record.data.path.text : null;
    const lineNumber = typeof record.data?.line_number === "number" ? record.data.line_number : null;
    const text = typeof record.data?.lines?.text === "string" ? record.data.lines.text : null;
    if (!filePath || lineNumber === null || text === null) continue;
    matches.push({ filePath, line: lineNumber, text: text.replace(/\r?\n$/, "").slice(0, 500) });
  }
  return matches;
}

function pathSearchItems(files: string[], query: string, limit: number): WorkspaceSearchItemsResult {
  const candidates: SearchItem[] = [];
  for (const filePath of files) {
    const match = pathSearchScore(filePath, query);
    if (!match) continue;
    candidates.push({
      ref: workspaceFileRef(filePath),
      title: filePath,
      snippet: pathSearchSnippet(match),
      score: match.score,
      metadata: {
        source: "workspace",
        matchKind: "path",
        searchMode: "path",
        path: filePath,
        matchedTerms: match.matchedTerms,
      },
    });
  }
  return finalizeSearchItems(candidates, limit);
}

function pathSearchSnippet(match: { exact: boolean; matchedTerms: string[] }): string {
  if (match.exact) return "Path match";
  if (match.matchedTerms.length > 0) return `Path terms: ${match.matchedTerms.join(", ")}`;
  return "Fuzzy path match";
}

async function rankedSearchItems(
  repoPath: string,
  files: string[],
  query: string,
  limit: number,
): Promise<WorkspaceSearchItemsResult> {
  const queryTerms = uniqueTerms(tokenizeSearchText(query));
  if (queryTerms.length === 0) return { items: [], truncated: false };

  const documents = (
    await mapWithConcurrency(files, 16, async (filePath) => rankedDocument(repoPath, filePath, queryTerms))
  ).filter((item): item is RankedDocument => Boolean(item));
  if (documents.length === 0) return { items: [], truncated: false };

  const documentFrequency = new Map<string, number>();
  for (const term of queryTerms) {
    documentFrequency.set(
      term,
      documents.filter((document) => document.termCounts.has(term) || document.pathTermCounts.has(term)).length,
    );
  }
  const averageLength = documents.reduce((sum, document) => sum + document.length, 0) / documents.length;
  const candidates: RankedCandidate[] = [];
  for (const document of documents) {
    const candidate = rankedCandidate(document, queryTerms, documentFrequency, documents.length, averageLength);
    if (candidate) candidates.push(candidate);
  }

  const items = candidates
    .sort((left, right) => right.score - left.score || left.document.filePath.localeCompare(right.document.filePath))
    .slice(0, limit)
    .map((candidate) => rankedSearchItem(candidate, queryTerms, query));
  return { items, truncated: candidates.length > limit };
}

async function rankedDocument(
  repoPath: string,
  filePath: string,
  queryTerms: string[],
): Promise<RankedDocument | null> {
  const sample = await readWorkspaceSearchText(repoPath, filePath);
  const pathTokens = tokenizeSearchText(filePath);
  const contentTokens = sample ? tokenizeSearchText(sample.text) : [];
  const termCounts = countsForTerms(contentTokens, queryTerms);
  const pathTermCounts = countsForTerms(pathTokens, queryTerms);
  if (termCounts.size === 0 && pathTermCounts.size === 0) return null;
  return {
    content: sample?.text ?? "",
    filePath,
    length: Math.max(1, contentTokens.length + pathTokens.length * PATH_TERM_WEIGHT),
    pathTermCounts,
    termCounts,
  };
}

function rankedCandidate(
  document: RankedDocument,
  queryTerms: string[],
  documentFrequency: Map<string, number>,
  documentCount: number,
  averageLength: number,
): RankedCandidate | null {
  let score = 0;
  const matchedTerms: string[] = [];
  for (const term of queryTerms) {
    const contentCount = document.termCounts.get(term) ?? 0;
    const pathCount = document.pathTermCounts.get(term) ?? 0;
    const frequency = contentCount + pathCount * PATH_TERM_WEIGHT;
    if (frequency <= 0) continue;
    matchedTerms.push(term);
    const containingDocuments = documentFrequency.get(term) ?? 0;
    const idf = Math.log(1 + (documentCount - containingDocuments + 0.5) / (containingDocuments + 0.5));
    const denominator = frequency + BM25_K1 * (1 - BM25_B + BM25_B * (document.length / averageLength));
    score += idf * ((frequency * (BM25_K1 + 1)) / denominator);
  }

  if (score <= 0) return null;
  score += pathCoverageBoost(document, queryTerms);
  return { document, matchedTerms, score };
}

function rankedSearchItem(candidate: RankedCandidate, queryTerms: string[], query: string): SearchItem {
  const bestLine = bestRankedLine(candidate.document.content, queryTerms, query);
  return {
    ref: workspaceFileRef(candidate.document.filePath),
    title: candidate.document.filePath,
    snippet: bestLine ? `${bestLine.line}: ${bestLine.text}` : `Matched terms: ${candidate.matchedTerms.join(", ")}`,
    score: roundScore(candidate.score),
    metadata: {
      source: "workspace",
      matchKind: "ranked",
      searchMode: "ranked",
      path: candidate.document.filePath,
      matchedTerms: candidate.matchedTerms,
      ...(bestLine ? { line: bestLine.line } : {}),
    },
  };
}

function exactTextMatch(content: string, lowerQuery: string): ExactTextMatch | null {
  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (line.toLowerCase().includes(lowerQuery)) {
      return { line: index + 1, text: line.slice(0, 500) };
    }
  }
  return null;
}

function bestRankedLine(
  content: string,
  queryTerms: string[],
  query: string,
): { line: number; score: number; text: string } | null {
  if (!content) return null;
  const lowerQuery = query.toLowerCase();
  let best: { line: number; score: number; text: string } | null = null;
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const lowerLine = line.toLowerCase();
    const exactBoost = lowerLine.includes(lowerQuery) ? 10 : 0;
    const lineTerms = tokenizeSearchText(line);
    const counts = countsForTerms(lineTerms, queryTerms);
    const score = exactBoost + [...counts.values()].reduce((sum, count) => sum + count, 0);
    if (score <= 0) continue;
    if (!best || score > best.score) {
      best = { line: index + 1, score, text: line.slice(0, 500) };
    }
  }
  return best;
}

function pathSearchScore(
  filePath: string,
  query: string,
): { exact: boolean; matchedTerms: string[]; score: number } | null {
  const lowerPath = filePath.toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (lowerPath.includes(lowerQuery)) {
    return { exact: true, matchedTerms: uniqueTerms(tokenizeSearchText(query)), score: 1 };
  }

  const queryTerms = uniqueTerms(tokenizeSearchText(query));
  const pathTerms = new Set(tokenizeSearchText(filePath));
  const matchedTerms = queryTerms.filter((term) => lowerPath.includes(term) || pathTerms.has(term));
  const tokenScore = queryTerms.length > 0 ? matchedTerms.length / queryTerms.length : 0;
  const fuzzyScore = orderedCharacterScore(lowerPath, lowerQuery);
  const score = Math.max(tokenScore * 0.92, fuzzyScore * 0.82);
  if (score < 0.35) return null;
  return { exact: false, matchedTerms, score: roundScore(score) };
}

function orderedCharacterScore(value: string, query: string): number {
  const needle = query.replace(/[^a-z0-9]/g, "");
  if (!needle) return 0;

  let position = -1;
  let first = -1;
  let last = -1;
  let boundaryMatches = 0;
  for (const char of needle) {
    const next = value.indexOf(char, position + 1);
    if (next < 0) return 0;
    if (first < 0) first = next;
    last = next;
    if (next === 0 || /[^a-z0-9]/.test(value[next - 1] ?? "")) boundaryMatches += 1;
    position = next;
  }

  const span = Math.max(1, last - first + 1);
  const compactness = needle.length / span;
  const boundaryBonus = boundaryMatches / needle.length;
  return Math.min(1, compactness * 0.7 + boundaryBonus * 0.3);
}

function workspaceRelativePathQuery(repoPath: string, query: string): string {
  if (!path.isAbsolute(query)) return query;
  const relative = path.relative(path.resolve(repoPath), path.resolve(query));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return query;
  }
  return relative.split(path.sep).join("/");
}

function workspaceSearchMode(filters: Record<string, unknown> | undefined): WorkspaceSearchMode {
  const raw = filters?.matchMode ?? filters?.mode;
  if (raw === undefined) return "exact";
  if (raw === "exact" || raw === "grep" || raw === "literal") return "exact";
  if (raw === "path" || raw === "file" || raw === "file-path" || raw === "fuzzy" || raw === "fuzzy-path") {
    return "path";
  }
  if (raw === "ranked" || raw === "bm25" || raw === "terms") return "ranked";
  throw new Error("filters.mode must be exact, path, or ranked");
}

async function visibleWorkspaceFiles(repoPath: string): Promise<string[]> {
  try {
    return await listWorkspaceFiles(repoPath);
  } catch {
    return listPlainWorkspaceFiles(repoPath);
  }
}

async function readWorkspaceSearchText(repoPath: string, filePath: string): Promise<TextSample | null> {
  if (BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return null;
  try {
    const { targetPath } = await resolveForRead(repoPath, filePath);
    const stat = await fs.lstat(targetPath);
    if (!stat.isFile()) return null;
    const text = await readTextSample(targetPath, stat.size);
    return text.includes("\0") ? null : { text, truncated: stat.size > WORKSPACE_SEARCH_MAX_BYTES };
  } catch {
    return null;
  }
}

async function readTextSample(targetPath: string, sizeBytes: number): Promise<string> {
  if (sizeBytes <= WORKSPACE_SEARCH_MAX_BYTES) {
    return fs.readFile(targetPath, "utf8");
  }

  const headBytes = Math.max(1, Math.floor(WORKSPACE_SEARCH_MAX_BYTES / 2));
  const tailBytes = Math.max(1, WORKSPACE_SEARCH_MAX_BYTES - headBytes);
  const file = await fs.open(targetPath, "r");
  try {
    const head = Buffer.alloc(headBytes);
    const tail = Buffer.alloc(tailBytes);
    const headRead = await file.read(head, 0, head.length, 0);
    const tailStart = Math.max(0, sizeBytes - tailBytes);
    const tailRead = await file.read(tail, 0, tail.length, tailStart);
    return [
      head.subarray(0, headRead.bytesRead).toString("utf8"),
      "\n\n[resource search truncated: middle omitted]\n\n",
      tail.subarray(0, tailRead.bytesRead).toString("utf8"),
    ].join("");
  } finally {
    await file.close();
  }
}

function tokenizeSearchText(value: string): string[] {
  const tokens: string[] = [];
  for (const run of value.match(/[A-Za-z0-9]+/g) ?? []) {
    const raw = run.toLowerCase();
    if (raw.length >= 2) tokens.push(raw);
    const expanded = run
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2");
    for (const part of expanded.match(/[A-Za-z0-9]+/g) ?? []) {
      const term = part.toLowerCase();
      if (term.length >= 2 && term !== raw) tokens.push(term);
    }
  }
  return tokens;
}

function uniqueTerms(terms: string[]): string[] {
  return [...new Set(terms)];
}

function countsForTerms(tokens: string[], terms: string[]): Map<string, number> {
  const wanted = new Set(terms);
  const counts = new Map<string, number>();
  for (const token of tokens) {
    if (!wanted.has(token)) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

function pathCoverageBoost(document: RankedDocument, queryTerms: string[]): number {
  if (queryTerms.length === 0) return 0;
  const pathMatches = queryTerms.filter((term) => document.pathTermCounts.has(term)).length;
  return (pathMatches / queryTerms.length) * 0.5;
}

function addSearchItem(candidates: Map<string, SearchItem>, item: SearchItem): void {
  const existing = candidates.get(item.ref);
  if (!existing || (item.score ?? 0) > (existing.score ?? 0)) {
    candidates.set(item.ref, item);
  }
}

function compareSearchItems(left: SearchItem, right: SearchItem): number {
  const scoreDelta = (right.score ?? 0) - (left.score ?? 0);
  if (scoreDelta !== 0) return scoreDelta;
  return left.title.localeCompare(right.title);
}

function finalizeSearchItems(candidates: SearchItem[], limit: number): WorkspaceSearchItemsResult {
  return {
    items: candidates.sort(compareSearchItems).slice(0, limit),
    truncated: candidates.length > limit,
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapItem: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapItem(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function normalizeLimit(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}

function workspaceFileRef(filePath: string): string {
  return `workspace:file:${filePath}`;
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}
