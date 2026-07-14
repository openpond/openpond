import { createHash } from "node:crypto";
import {
  TrainingChatSearchRequestSchema,
  TrainingChatSearchResultSchema,
  type Session,
  type TrainingChatSearchRequest,
  type TrainingChatSearchResult,
} from "@openpond/contracts";
import {
  codexHistoryThreadIdFromSessionId,
  loadCodexHistorySearchFiles,
  readCodexHistorySearchText,
} from "../codex-history.js";
import type {
  SqliteStore,
  TrainingChatSearchDocument,
} from "../store/store.js";

type SearchCandidate = TrainingChatSearchRequest["candidates"][number];

export function createTrainingChatSearchService(deps: { store: SqliteStore }) {
  let metadataKey: string | null = null;
  let activeIndexKey: string | null = null;
  let completedIndexKey: string | null = null;
  let pendingIndex: { candidates: SearchCandidate[]; key: string } | null = null;
  let indexPromise: Promise<void> | null = null;

  async function search(input: TrainingChatSearchRequest): Promise<TrainingChatSearchResult> {
    const request = TrainingChatSearchRequestSchema.parse(input);
    const candidates = uniqueCandidates(request.candidates);
    await syncMetadata(candidates);
    scheduleBodyIndex(candidates);
    const result = await deps.store.searchTrainingChats({
      query: request.query,
      offset: request.offset,
      limit: request.limit,
      candidateIds: candidates.map((candidate) => candidate.sessionId),
    });
    return TrainingChatSearchResultSchema.parse(result);
  }

  async function syncMetadata(candidates: SearchCandidate[]): Promise<void> {
    const nextKey = candidateSetKey(candidates);
    if (metadataKey === nextKey) return;
    const [openPondEvidence, knownCodexSignatures] = await Promise.all([
      deps.store.openPondTrainingChatSearchEvidence(candidates.map((candidate) => candidate.sessionId)),
      deps.store.trainingChatSearchSignatures("codex"),
    ]);
    const openPondDocuments = openPondSearchDocuments(openPondEvidence);
    const knownOpenPondIds = new Set(openPondDocuments.map((document) => document.sessionId));
    for (const candidate of candidates) {
      if (knownOpenPondIds.has(candidate.sessionId) || codexHistoryThreadIdFromSessionId(candidate.sessionId)) continue;
      openPondDocuments.push(candidateDocument("openpond", candidate, "", `title:${candidateSignature(candidate)}`, true));
    }
    const codexDocuments = candidates.flatMap((candidate) => {
      if (!codexHistoryThreadIdFromSessionId(candidate.sessionId)) return [];
      const baseSignature = candidateSignature(candidate);
      const bodySignature = `body:${baseSignature}`;
      const indexed = knownCodexSignatures.get(candidate.sessionId) === bodySignature;
      return [candidateDocument(
        "codex",
        candidate,
        "",
        indexed ? bodySignature : `metadata:${baseSignature}`,
        indexed,
      )];
    });
    await Promise.all([
      deps.store.syncTrainingChatSearchDocuments("openpond", openPondDocuments),
      deps.store.syncTrainingChatSearchDocuments("codex", codexDocuments),
    ]);
    metadataKey = nextKey;
  }

  function scheduleBodyIndex(candidates: SearchCandidate[]): void {
    const codexCandidates = candidates.filter((candidate) => codexHistoryThreadIdFromSessionId(candidate.sessionId));
    const key = candidateSetKey(codexCandidates);
    if (!codexCandidates.length || key === activeIndexKey || key === completedIndexKey || pendingIndex?.key === key) return;
    pendingIndex = { candidates: codexCandidates, key };
    if (indexPromise) return;
    indexPromise = runPendingIndexes().finally(() => {
      indexPromise = null;
      activeIndexKey = null;
    });
  }

  async function runPendingIndexes(): Promise<void> {
    while (pendingIndex) {
      const next = pendingIndex;
      pendingIndex = null;
      activeIndexKey = next.key;
      await indexCodexBodies(next.candidates);
      completedIndexKey = next.key;
    }
  }

  async function indexCodexBodies(candidates: SearchCandidate[]): Promise<void> {
    const [files, knownSignatures] = await Promise.all([
      loadCodexHistorySearchFiles(),
      deps.store.trainingChatSearchSignatures("codex"),
    ]);
    const fileByThreadId = new Map(files.map((file) => [file.threadId, file]));
    for (const candidate of candidates) {
      const bodySignature = `body:${candidateSignature(candidate)}`;
      if (knownSignatures.get(candidate.sessionId) === bodySignature) continue;
      const threadId = codexHistoryThreadIdFromSessionId(candidate.sessionId);
      const file = threadId ? fileByThreadId.get(threadId) : null;
      const body = file
        ? await readCodexHistorySearchText({ filePath: file.filePath }).catch(() => "")
        : "";
      await deps.store.upsertTrainingChatSearchDocument(
        candidateDocument("codex", candidate, body, bodySignature, true),
      );
      await yieldToRuntime();
    }
  }

  return { search };
}

function openPondSearchDocuments(
  evidence: Array<{ session: Session; body: string }>,
): TrainingChatSearchDocument[] {
  return evidence.map(({ session, body }) => {
    return {
      sessionId: session.id,
      source: "openpond",
      signature: hash([session.title, session.updatedAt, body]),
      title: session.title.trim() || "Untitled chat",
      body,
      updatedAt: session.updatedAt,
      eligible: true,
      bodyIndexed: true,
    };
  });
}

function candidateDocument(
  source: TrainingChatSearchDocument["source"],
  candidate: SearchCandidate,
  body: string,
  signature: string,
  bodyIndexed: boolean,
): TrainingChatSearchDocument {
  return {
    sessionId: candidate.sessionId,
    source,
    signature,
    title: candidate.title,
    body,
    updatedAt: candidate.updatedAt,
    eligible: true,
    bodyIndexed,
  };
}

function uniqueCandidates(candidates: SearchCandidate[]): SearchCandidate[] {
  const byId = new Map<string, SearchCandidate>();
  for (const candidate of candidates) byId.set(candidate.sessionId, candidate);
  return [...byId.values()];
}

function candidateSetKey(candidates: SearchCandidate[]): string {
  return hash(candidates.map((candidate) => `${candidate.sessionId}:${candidate.title}:${candidate.updatedAt}`).sort());
}

function candidateSignature(candidate: SearchCandidate): string {
  return hash([candidate.sessionId, candidate.title, candidate.updatedAt]);
}

function hash(parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

function yieldToRuntime(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
