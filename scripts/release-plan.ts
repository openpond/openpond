export type ReleaseBump = "patch" | "minor" | "major";

export type PrepareReleasePlan = {
  branch: string;
  bump: ReleaseBump;
  kind: "prepare";
  tag: string;
  version: string;
};

export type PublishReleasePlan = {
  kind: "publish";
  tag: string;
  version: string;
};

export type ReleasePlan = PrepareReleasePlan | PublishReleasePlan;

export const RELEASE_BRANCH_PREFIX = "feat/release-v";

export function stableVersion(input: string): string {
  const version = input.startsWith("v") ? input.slice(1) : input;
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) {
    throw new Error(
      `Stable releases require a plain semver version like 0.1.0, received: ${input}`,
    );
  }
  return version;
}

export function bumpVersion(current: string, bump: ReleaseBump): string {
  const version = stableVersion(current);
  const [major, minor, patch] = version.split(".").map((part) => Number.parseInt(part, 10)) as [
    number,
    number,
    number,
  ];
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export function parseReleaseArg(args: readonly string[]): ReleaseBump | string | null {
  const positional = args.filter((item) => !item.startsWith("--"));
  if (positional.length > 1) {
    throw new Error(
      `Expected at most one release version or bump, received: ${positional.join(" ")}`,
    );
  }
  const arg = positional[0];
  if (!arg) return null;
  if (arg === "patch" || arg === "minor" || arg === "major") return arg;
  return stableVersion(arg);
}

export function resolveReleasePlan(
  currentVersionInput: string,
  request: ReleaseBump | string | null,
): ReleasePlan {
  const currentVersion = stableVersion(currentVersionInput);
  if (request === "patch" || request === "minor" || request === "major") {
    const version = bumpVersion(currentVersion, request);
    return {
      branch: `${RELEASE_BRANCH_PREFIX}${version}`,
      bump: request,
      kind: "prepare",
      tag: `v${version}`,
      version,
    };
  }

  const version = request ? stableVersion(request) : currentVersion;
  if (version !== currentVersion) {
    throw new Error(
      `Manual stable publishing must use the checked-in version ${currentVersion}, received: ${version}`,
    );
  }
  return { kind: "publish", tag: `v${version}`, version };
}

export function releasePullRequestTitle(plan: PrepareReleasePlan): string {
  return `chore: release ${plan.tag}`;
}

export function releasePullRequestBody(plan: PrepareReleasePlan, sourceSha: string): string {
  return [
    `Prepares OpenPond App ${plan.tag} from \`${sourceSha}\`.`,
    "",
    "Merging this PR triggers the protected stable release workflow after the required `Checks` job passes on `master`.",
  ].join("\n");
}
