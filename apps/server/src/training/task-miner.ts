import { randomUUID } from "node:crypto";
import {
  TaskCandidateSchema,
  TaskMinerConfigSchema,
  type TaskCandidate,
  type TaskCandidateEvidence,
  type TaskCandidateScorecard,
  type TaskMinerConfig,
  type TrainingSourceRef,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";
import type { SqliteStore } from "../store/store.js";
import { now } from "../utils.js";
import { recommendTrainingTactic } from "./tactic-recommender.js";

export const DEFAULT_TASK_MINER_CONFIG: TaskMinerConfig = TaskMinerConfigSchema.parse({
  schemaVersion: "openpond.taskMinerConfig.v1",
  enabled: false,
  localOnly: true,
  observationWindowDays: 30,
  minimumRecurrence: 3,
  clustering: "hybrid_deterministic_first",
  consentRequired: true,
});

export function createTaskMinerService(deps: { store: SqliteStore }) {
  async function config(profileId: string): Promise<TaskMinerConfig> {
    return (await deps.store.getTaskMinerConfig(profileId)) ?? DEFAULT_TASK_MINER_CONFIG;
  }

  async function updateConfig(profileId: string, value: unknown): Promise<TaskMinerConfig> {
    return deps.store.saveTaskMinerConfig(profileId, TaskMinerConfigSchema.parse(value));
  }

  async function run(input: { profileId: string; sourceIds?: string[]; config?: TaskMinerConfig }): Promise<TaskCandidate[]> {
    const activeConfig = TaskMinerConfigSchema.parse(input.config ?? await config(input.profileId));
    if (input.config) await deps.store.saveTaskMinerConfig(input.profileId, activeConfig);
    const allSources = await deps.store.listTrainingSources(input.profileId);
    const sourceFilter = input.sourceIds?.length ? new Set(input.sourceIds) : null;
    const cutoff = Date.now() - activeConfig.observationWindowDays * 24 * 60 * 60 * 1_000;
    const sources = allSources.filter((source) => (!sourceFilter || sourceFilter.has(source.id)) && Date.parse(source.occurredAt) >= cutoff && (!activeConfig.consentRequired || source.consent.status === "granted"));
    const groups = clusterSources(sources);
    const candidates: TaskCandidate[] = [];
    for (const [signature, group] of groups) {
      if (group.length < activeConfig.minimumRecurrence) continue;
      const evidence = group.map((source) => evidenceFromSource(source, signature));
      const scorecard = scoreCandidate(group, evidence);
      const fingerprint = contentHash([input.profileId, signature]);
      const existing = await deps.store.findTaskCandidateByFingerprint(input.profileId, fingerprint);
      const timestamp = now();
      const candidate = TaskCandidateSchema.parse({
        schemaVersion: "openpond.taskCandidate.v1",
        id: existing?.id ?? `task_candidate_${randomUUID()}`,
        profileId: input.profileId,
        status: existing?.status === "dismissed" || existing?.status === "rejected" ? existing.status : "needs_review",
        fingerprint,
        title: titleForGroup(group),
        summary: `${group.length} consented conversations share the workflow signature “${signature}”.`,
        workflowSignature: signature,
        evidence,
        scorecard,
        recommendation: recommendTrainingTactic({ evidence, scorecard, changingFacts: group.some((source) => source.metadata.changingFacts === true) }),
        mergedIntoId: existing?.mergedIntoId ?? null,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        metadata: { sourceCount: group.length, clustering: activeConfig.clustering },
      });
      await deps.store.upsertTaskCandidate(candidate);
      candidates.push(candidate);
    }
    return candidates;
  }

  async function patch(id: string, input: { status?: TaskCandidate["status"]; mergeIntoId?: string | null }): Promise<TaskCandidate> {
    const candidate = await deps.store.getTaskCandidate(id);
    if (!candidate) throw new Error("Task Candidate not found.");
    if (input.mergeIntoId) {
      const target = await deps.store.getTaskCandidate(input.mergeIntoId);
      if (!target || target.profileId !== candidate.profileId) throw new Error("Merge target was not found in this profile.");
    }
    return deps.store.upsertTaskCandidate(TaskCandidateSchema.parse({ ...candidate, status: input.mergeIntoId ? "retired" : input.status ?? candidate.status, mergedIntoId: input.mergeIntoId ?? candidate.mergedIntoId, updatedAt: now() }));
  }

  return { config, updateConfig, run, patch };
}

function clusterSources(sources: TrainingSourceRef[]): Map<string, TrainingSourceRef[]> {
  const groups = new Map<string, TrainingSourceRef[]>();
  for (const source of sources) {
    const signature = workflowSignature(source);
    const group = groups.get(signature) ?? [];
    group.push(source);
    groups.set(signature, group);
  }
  return groups;
}

function workflowSignature(source: TrainingSourceRef): string {
  const declared = typeof source.metadata.workflowSignature === "string" ? source.metadata.workflowSignature.trim() : "";
  if (declared) return declared.slice(0, 2_000);
  const stop = new Set(["the", "a", "an", "and", "or", "to", "for", "of", "in", "on", "with", "chat", "task"]);
  const tokens = source.title.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((token) => token.length > 2 && !stop.has(token));
  return [...new Set(tokens)].sort().slice(0, 8).join(":") || "general_workflow";
}

function evidenceFromSource(source: TrainingSourceRef, signature: string): TaskCandidateEvidence {
  const kind = source.metadata.acceptedCorrection === true
    ? "accepted_correction"
    : source.metadata.runtimeFeedback === true
      ? "runtime_feedback"
      : source.metadata.agentAction === true
        ? "agent_action_recurrence"
        : source.metadata.outcomeLinkedChange === true
          ? "outcome_linked_change"
          : source.metadata.frontierCost === true
            ? "frontier_cost"
            : "repeated_success";
  return { id: `task_evidence_${contentHash([source.id, kind]).slice(0, 20)}`, kind, sourceRefIds: [source.id], occurredAt: source.occurredAt, signature, summary: source.title, confidence: typeof source.metadata.confidence === "number" ? Math.max(0, Math.min(1, source.metadata.confidence)) : 0.75, consented: source.consent.status === "granted", metadata: {} };
}

function scoreCandidate(sources: TrainingSourceRef[], evidence: TaskCandidateEvidence[]): TaskCandidateScorecard {
  const recurrence = Math.min(1, sources.length / 10);
  const verifiable = sources.some((source) => source.metadata.verifiableOutcome === true) ? 0.9 : sources.some((source) => source.metadata.acceptedCorrection === true) ? 0.65 : 0.45;
  const privacyRisk = sources.some((source) => source.secretScanStatus === "blocked") ? 1 : sources.some((source) => source.piiScanStatus === "review") ? 0.5 : 0.1;
  const frontierCost = sources.some((source) => source.metadata.frontierCost === true) ? 0.9 : 0.4;
  const signalQuality = evidence.reduce((sum, item) => sum + item.confidence, 0) / Math.max(1, evidence.length);
  const overall = Math.max(0, Math.min(1, recurrence * 0.2 + verifiable * 0.2 + signalQuality * 0.25 + frontierCost * 0.15 + (1 - privacyRisk) * 0.2));
  return { frequency: recurrence, businessValue: 0.6, frontierCost, signalQuality, verifiability: verifiable, repeatability: recurrence, privacyRisk, overall };
}

function titleForGroup(sources: TrainingSourceRef[]): string {
  const first = sources[0]?.title ?? "Repeated workflow";
  return first.length <= 80 ? first : `${first.slice(0, 77)}…`;
}
