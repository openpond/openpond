import type { CreateImproveRun } from "@openpond/contracts/create-pipeline";
import { loadGitCommitDiffAtPath } from "../workspace/workspace-diff.js";

/** Reads the selected candidate's retained repository and exact commit pair. */
export function createImproveCandidateDiffPayload(getRun: (id: string) => Promise<CreateImproveRun | null>) {
  return async (runId: string, candidateId: string) => {
        const run = await getRun(runId);
        if (!run) throw new Error("Create/Improve run not found.");
        const candidate = run.candidates.find(
          (item) => item.id === candidateId
        );
        if (!candidate?.git?.headCommit)
          throw new Error("Candidate change is not available.");
        const repoPath =
          candidate.git.worktreePath ??
          (run.adapter.kind === "local" ||
          run.adapter.kind === "promote_local_to_hosted"
            ? run.adapter.repoPath
            : null);
        if (!repoPath)
          throw new Error("Candidate source is no longer available.");
        return loadGitCommitDiffAtPath(
          repoPath,
          `candidate:${run.id}:${candidate.id}`,
          candidate.git.baseCommit,
          candidate.git.headCommit
        );
  };
}
