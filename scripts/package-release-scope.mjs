import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";

export const releasePackages = {
  evals: "@openpond/evals",
  harness: "@openpond/harness",
  sdk: "openpond-sdk",
  "agent-sdk": "openpond-agent-sdk",
};
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

// Failure story: a dependency/export/source change must never inherit the
// application's previous proof merely because its commit also bumps a version.
export function classifyPackageRelease(changes) {
  if (changes.length !== 1) return "";
  const [{ status, path, before, after }] = changes;
  const key = Object.keys(releasePackages).find((name) => path === `packages/${name}/package.json`);
  if (!key || status !== "M") return "";
  try {
    const { version: oldVersion, ...oldManifest } = JSON.parse(before);
    const { version: newVersion, ...newManifest } = JSON.parse(after);
    if (oldManifest.name !== releasePackages[key] || !isDeepStrictEqual(oldManifest, newManifest)) return "";
    if (typeof oldVersion !== "string" || typeof newVersion !== "string" || !stableVersion.test(oldVersion) || !stableVersion.test(newVersion)) return "";
    const oldParts = oldVersion.split(".").map(BigInt);
    const newParts = newVersion.split(".").map(BigInt);
    const index = oldParts.findIndex((part, i) => part !== newParts[i]);
    return index >= 0 && newParts[index] > oldParts[index] ? key : "";
  } catch {
    return "";
  }
}

export function readPackageRelease(base, head, cwd = process.cwd(), staged = false) {
  const git = (args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    if (!base || /^0+$/.test(base)) return "";
    git(["rev-parse", "--verify", `${base}^{commit}`]);
    if (!staged) git(["merge-base", "--is-ancestor", base, head]);
    const diff = staged ? ["--cached", base] : [base, head];
    if (git(["diff", "--summary", ...diff]).trim()) return "";
    const entries = git(["diff", "--name-status", "--no-renames", "-z", ...diff]).split("\0").filter(Boolean);
    if (entries.length !== 2 || entries[0] !== "M") return "";
    const [status, path] = entries;
    if (!Object.keys(releasePackages).some((key) => path === `packages/${key}/package.json`)) return "";
    return classifyPackageRelease([{ status, path, before: git(["show", `${base}:${path}`]), after: git(["show", staged ? `:${path}` : `${head}:${path}`]) }]);
  } catch {
    return "";
  }
}

export function isTrustedCiProof(run, jobs, sha, repository) {
  return run?.head_sha === sha && run?.event === "push" && run?.head_branch === "master"
    && run?.repository?.full_name === repository && run?.head_repository?.full_name === repository
    && run?.path === ".github/workflows/ci.yml" && run?.status === "completed" && run?.conclusion === "success"
    && jobs.filter((job) => job.name === "Checks").length === 1
    && jobs.some((job) => job.name === "Checks" && job.conclusion === "success" && job.status === "completed"
      && job.head_sha === sha && job.run_attempt === run.run_attempt);
}

export async function hasTrustedCiProof(sha, repository = process.env.GITHUB_REPOSITORY, token = process.env.GH_TOKEN) {
  if (!repository || !token || !/^[0-9a-f]{40}$/.test(sha)) return false;
  const api = async (suffix) => {
    const response = await fetch(`https://api.github.com/repos/${repository}/${suffix}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`CI proof API returned ${response.status}`);
    return response.json();
  };
  try {
    const { workflow_runs: runs } = await api(`actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&branch=master&per_page=10`);
    // Use the latest run and latest attempt, including pending/failed reruns.
    const run = runs?.sort((a, b) => b.id - a.id)[0];
    if (!run || run.status !== "completed" || run.conclusion !== "success") return false;
    const { jobs, total_count: count } = await api(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
    return count <= 100 && isTrustedCiProof(run, jobs, sha, repository);
  } catch (error) {
    console.log(`[ci-proof] ${error.message}; requiring full CI`);
    return false;
  }
}
