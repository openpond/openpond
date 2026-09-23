import { promises as fs } from "node:fs";
import path from "node:path";

import { z } from "zod";
import { contentHash, ReleaseIdSchema } from "@openpond/harness";
import { type OpenPondProfileRef } from "@openpond/contracts";
import {
  assertProfileEvaluationReport, createProfileEvaluationReport,
  type ProfileEvaluationReport,
} from "@openpond/evals";

import type { SqliteStore } from "../store/store.js";
import type { LocalProfileEvaluationRun } from "../store/store-evaluation-results.js";

const SaveRequestSchema = z.object({
  id: ReleaseIdSchema,
  evidenceKind: z.enum(["run", "suite", "comparison"]),
  evidenceId: ReleaseIdSchema,
}).strict();

type SelectedProfile = { ref: OpenPondProfileRef; sourcePath: string; gitBacked: boolean };

function reportDirectory(sourcePath: string): string {
  return path.join(sourcePath, "evals", "reports");
}

async function ensureRegularDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
    throw new Error("Profile evaluation report directory must be a regular directory.");
  }
  if (!stat) await fs.mkdir(directory);
}

async function loadRuns(input: {
  store: SqliteStore; profileRef: OpenPondProfileRef;
  evidenceKind: "run" | "suite" | "comparison"; evidenceId: string;
}): Promise<{ runs: LocalProfileEvaluationRun[]; primary: { kind: "run" | "suite" | "comparison"; id: string; contentHash: string } }> {
  let ids: string[];
  let primaryHash: string;
  if (input.evidenceKind === "run") {
    ids = [input.evidenceId];
    primaryHash = "";
  } else if (input.evidenceKind === "suite") {
    const suite = await input.store.getProfileEvaluationSuiteRun(input.evidenceId);
    if (!suite || suite.profileId !== input.profileRef.profileId) throw new Error("Profile evaluation suite is unavailable.");
    ids = suite.members.map((member) => member.runManifest.id);
    primaryHash = suite.contentHash;
  } else {
    const comparison = await input.store.getProfileEvaluationComparison(input.evidenceId);
    if (!comparison) throw new Error("Profile evaluation comparison is unavailable.");
    ids = comparison.members.map((member) => member.runManifest.id);
    primaryHash = comparison.contentHash;
  }
  const runs = await Promise.all(ids.map((id) => input.store.getProfileEvaluationRun(id)));
  if (runs.some((run) => !run || contentHash(run.profileRef) !== contentHash(input.profileRef))) {
    throw new Error("Profile evaluation report is missing authorized run evidence.");
  }
  const verified = runs as LocalProfileEvaluationRun[];
  if (input.evidenceKind === "run") primaryHash = verified[0]!.contentHash;
  if (input.evidenceKind !== "run") {
    const refs = input.evidenceKind === "suite"
      ? (await input.store.getProfileEvaluationSuiteRun(input.evidenceId))!.members.map((member) => member.runHash)
      : (await input.store.getProfileEvaluationComparison(input.evidenceId))!.members.map((member) => member.metricResultHash);
    for (const [index, run] of verified.entries()) {
      if (input.evidenceKind === "suite" && refs[index] !== run.contentHash
        || input.evidenceKind === "comparison" && refs[index] !== run.metric.contentHash) {
        throw new Error("Profile evaluation report evidence differs from retained member runs.");
      }
    }
  }
  return { runs: verified, primary: { kind: input.evidenceKind, id: input.evidenceId, contentHash: primaryHash } };
}

/** Build only from retained evidence. Hosted callers can persist the returned
 * document through their authorized Profile source adapter. */
export async function buildProfileEvaluationReport(input: {
  store: SqliteStore; profileRef: OpenPondProfileRef; request: unknown;
}): Promise<ProfileEvaluationReport> {
  const parsed = SaveRequestSchema.parse(input.request);
  const { runs, primary } = await loadRuns({
    store: input.store, profileRef: input.profileRef,
    evidenceKind: parsed.evidenceKind, evidenceId: parsed.evidenceId,
  });
  const unique = <T>(values: T[]): T[] => [...new Map(values.map((value) => [contentHash(value), value])).values()];
  const policyHashes = unique(runs.map((run) => contentHash(run.manifest.metricPolicy)));
  const scores = runs.map((run) => run.metric.value).filter((score): score is number => score !== null);
  return createProfileEvaluationReport({
    schemaVersion: "openpond.profileEvaluationReport.v1",
    id: parsed.id, createdAt: new Date().toISOString(),
    testedSources: unique(runs.map((run) => ({
      profileId: run.manifest.profileEvaluation!.profileId,
      sourceRevision: run.manifest.profileEvaluation!.sourceRevision,
      harnessRelease: run.manifest.profileEvaluation!.harnessRelease,
    }))),
    tasksetReleases: unique(runs.map((run) => run.manifest.tasksetRelease)),
    metricPolicyHashes: policyHashes,
    modelConfigurationHashes: unique(runs.map((run) => run.manifest.policy.kind === "model"
      ? run.manifest.policy.configurationHash : contentHash(run.manifest.policy))),
    evidence: [primary, ...runs.filter((run) => primary.kind !== "run" || run.manifest.id !== primary.id).map((run) => ({
      kind: "run" as const, id: run.manifest.id, contentHash: run.contentHash,
    }))],
    summary: {
      totalChecks: runs.length,
      passedChecks: runs.filter((run) => run.passed).length,
      failedChecks: runs.filter((run) => !run.passed && run.metric.value !== null).length,
      unscoredChecks: runs.filter((run) => !run.passed && run.metric.value === null).length,
      meanScore: policyHashes.length === 1 && scores.length === runs.length
        ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null,
    },
  });
}

/** Write only a compact, evidence-linked summary to the selected Git Profile.
 * The next Profile commit/push remains an explicit user action. */
export function createProfileEvaluationReportService(input: {
  store: SqliteStore;
  selectedProfile: () => Promise<SelectedProfile | null>;
}) {
  const list = async (): Promise<ProfileEvaluationReport[]> => {
    const selected = await input.selectedProfile();
    if (!selected) return [];
    const directory = reportDirectory(selected.sourcePath);
    const stat = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) return [];
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Profile evaluation report directory is unsafe.");
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const reports = await Promise.all(entries.filter((entry) => entry.name.endsWith(".json")).map(async (entry) => {
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Profile evaluation report must be a regular file.");
      const report = assertProfileEvaluationReport(JSON.parse(await fs.readFile(path.join(directory, entry.name), "utf8")));
      if (`${report.id}.json` !== entry.name || report.testedSources.some((source) => source.profileId !== selected.ref.profileId)) {
        throw new Error("Profile evaluation report differs from its source location.");
      }
      return report;
    }));
    return reports.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  };
  const save = async (request: unknown): Promise<ProfileEvaluationReport> => {
    const selected = await input.selectedProfile();
    if (!selected?.gitBacked) throw new Error("Select a Git-backed Profile before saving an evaluation report.");
    const report = await buildProfileEvaluationReport({ store: input.store, profileRef: selected.ref, request });
    const evalsDir = path.join(selected.sourcePath, "evals");
    await ensureRegularDirectory(evalsDir);
    const directory = reportDirectory(selected.sourcePath);
    await ensureRegularDirectory(directory);
    await fs.writeFile(path.join(directory, `${report.id}.json`), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
    return report;
  };
  return { list, save };
}
