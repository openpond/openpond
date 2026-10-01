import { execFileSync } from "node:child_process";
import { requireReleaseIdentity, requireStableMaster } from "./cli-release-policy.mjs";

requireStableMaster(process.env.GITHUB_REF);
const { TAG: tag, RELEASE_SHA: sha, RELEASE_NAME: name, GITHUB_REPOSITORY: repository, GH_TOKEN: token } = process.env;
if (!/^cli-v\d+\.\d+\.\d+$/.test(tag || "") || !/^[0-9a-f]{40}$/.test(sha || "") || !repository || !token) throw new Error("Exact CLI release identity is required.");
const api = async (path) => {
  const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub release lookup failed: ${response.status}`);
  return response.json();
};
const inspect = async () => {
  const reference = await api(`git/ref/tags/${tag}`);
  const release = await api(`releases/tags/${tag}`);
  if (!reference) {
    if (release) throw new Error("Existing CLI release is missing its source tag.");
    return false;
  }
  let object = reference.object;
  while (object.type === "tag") object = (await api(`git/tags/${object.sha}`)).object;
  if (object.type !== "commit") throw new Error("CLI tag must resolve to a commit.");
  requireReleaseIdentity(object.sha, release, { tag, sha });
  return Boolean(release);
};
if (!await inspect()) {
  let creationError;
  try {
    execFileSync("gh", ["release", "create", tag, "--target", sha, "--title", name, "--generate-notes", "--latest=false"], { stdio: "inherit" });
  } catch (error) { creationError = error; }
  // Recover both a lost creation acknowledgement and concurrent same-source
  // recovery. Never accept an existing release whose tag belongs to another SHA.
  let complete = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (await inspect()) { complete = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  if (!complete) throw creationError || new Error("CLI GitHub release was not confirmed.");
}
console.log(`Confirmed ${tag} on ${sha}.`);
