import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  collectProfileSourceUploadEntries,
  commitActiveProfileChanges,
  defaultLocalProfileRepoPath,
  formatOpenPondProfileSetupRequirement,
  initLocalProfileRepo,
  loadLocalProfileRepo,
  loadOpenPondProfileState,
  runProfileCheck,
  runProfileSdkCommand,
  saveProfilePushStatus,
  type LocalOpenPondProfilePushStatus,
  type ProfileRepoManifest,
} from "../profile/local-profile";
import {
  optionString,
  parseBooleanOption,
  requiredTeamId,
  resolveSandboxClient,
} from "./common";
import type { OpenPondHostedProfileSummary } from "../sandbox/types/index";

type CliOptions = Record<string, string | boolean>;

export async function runOpenPondInitCommand(options: CliOptions): Promise<void> {
  const state = await initLocalProfileRepo({
    repoPath: optionString(options, "path") || defaultLocalProfileRepoPath(),
    profile: optionString(options, "profile") || "default",
    template: optionString(options, "template") || "blank-agent",
    force: parseBooleanOption(options.force),
  });
  if (parseBooleanOption(options.json)) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  console.log(`Initialized OpenPond profile ${state.activeProfile} at ${state.repoPath}`);
  console.log(`Profile source: ${state.sourcePath}`);
}

export async function runOpenPondProfileCommand(options: CliOptions, rest: string[]): Promise<void> {
  const subcommand = rest[0] ?? "current";
  if (subcommand === "load") {
    const repoPath = optionString(options, "path") || rest[1];
    if (!repoPath) {
      throw new Error("usage: openpond profile load --path <dir> [--profile <name>]");
    }
    const state = await loadLocalProfileRepo(repoPath, optionString(options, "profile") || undefined);
    if (parseBooleanOption(options.json)) {
      console.log(JSON.stringify(state, null, 2));
      return;
    }
    console.log(`Loaded OpenPond profile ${state.activeProfile} from ${state.repoPath}`);
    return;
  }
  if (subcommand === "current" || subcommand === "status") {
    const state = await loadOpenPondProfileState();
    if (parseBooleanOption(options.json)) {
      console.log(JSON.stringify(state, null, 2));
      return;
    }
    printProfileState(state);
    return;
  }
  if (subcommand === "diff") {
    const state = await loadOpenPondProfileState();
    if (parseBooleanOption(options.json)) {
      console.log(JSON.stringify({ diff: state.diff, profile: state }, null, 2));
      return;
    }
    printProfileDiff(state);
    return;
  }
  if (subcommand === "catalog") {
    const state = await loadOpenPondProfileState();
    if (parseBooleanOption(options.json)) {
      console.log(JSON.stringify({ catalog: state.catalog, actions: state.actionCatalog, profile: state }, null, 2));
      return;
    }
    printProfileCatalog(state);
    return;
  }
  if (subcommand === "commit") {
    await runProfileCommitCommand(options, rest.slice(1));
    return;
  }
  if (subcommand === "push") {
    await runProfilePushCommand(options);
    return;
  }
  if (subcommand === "check") {
    await runProfileCheck(optionString(options, "kind") || rest[1] || "all");
    return;
  }
  if (subcommand === "ensure-hosted") {
    await runHostedProfileEnsureCommand(options);
    return;
  }
  if (subcommand === "hosted") {
    const nested = rest[1] ?? "status";
    if (nested === "ensure") {
      await runHostedProfileEnsureCommand(options);
      return;
    }
    if (nested === "status" || nested === "current") {
      await runHostedProfileStatusCommand(options);
      return;
    }
    throw new Error("usage: openpond profile hosted [status|ensure] --team-id <id> [--json]");
  }
  if (subcommand === "agents") {
    const nested = rest[1] ?? "list";
    if (nested !== "list") {
      throw new Error("usage: openpond profile agents list [--json]");
    }
    await runOpenPondAgentsCommand(options, ["list"]);
    return;
  }
  throw new Error("usage: openpond profile <status|diff|catalog|commit|push|load|check|agents|hosted|ensure-hosted> [args]");
}

async function runProfileCommitCommand(options: CliOptions, rest: string[]): Promise<void> {
  const message =
    optionString(options, "message") ||
    optionString(options, "commitMessage") ||
    rest.join(" ").trim() ||
    undefined;
  const result = await commitActiveProfileChanges(message);
  if (parseBooleanOption(options.json)) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (!result.committed) {
    console.log("No profile changes to commit.");
    printProfileState(result.state);
    return;
  }
  console.log("Committed OpenPond profile changes.");
  if (result.stdout.trim()) console.log(result.stdout.trim());
  printProfileState(result.state);
}

async function runProfilePushCommand(options: CliOptions): Promise<void> {
  const teamId = requiredTeamId(options, "usage: openpond profile push");
  const state = await loadOpenPondProfileState();
  if (state.error) throw new Error(state.error);
  if (!state.repoPath || !state.sourcePath || !state.manifestPath) {
    throw new Error("No active OpenPond profile. Run `openpond init`.");
  }
  if (!state.git?.isRepo) {
    throw new Error("Active OpenPond profile source is not Git-backed. Run `openpond init` or reload a Git-backed profile.");
  }
  if (!state.git.head) {
    throw new Error("Profile source must have a committed Git head before push. Run `openpond profile commit` first.");
  }
  if (state.git.dirty) {
    throw new Error("Profile source has uncommitted changes. Run `openpond profile commit` before push.");
  }

  const client = await resolveSandboxClient(options);
  const hosted = parseBooleanOption(options.ensureHosted)
    ? await client.profile.ensureHosted({ teamId })
    : await client.profile.get({ teamId });
  if (!hosted) {
    throw new Error("No hosted OpenPond profile repo found. Run `openpond profile ensure-hosted --team-id <id>` first, or pass `--ensure-hosted` to push.");
  }
  const force = parseBooleanOption(options.force);
  const currentHostedHead = hosted.sourceUpload?.sourceCommitSha ?? null;
  const lastPushedHostedHead = state.hosted?.sourceCommitSha ?? null;
  if (lastPushedHostedHead && currentHostedHead !== lastPushedHostedHead && !force) {
    throw new Error(
      [
        "Hosted profile source changed since the last local push.",
        `Last pushed hosted head: ${lastPushedHostedHead}`,
        `Current hosted head: ${currentHostedHead ?? "none"}`,
        "Inspect hosted changes before pushing, or rerun with --force to overwrite explicitly.",
      ].join("\n"),
    );
  }

  const manifest = JSON.parse(await readFile(state.manifestPath, "utf8")) as ProfileRepoManifest;
  const sourcePath = manifest.profiles[state.activeProfile ?? manifest.defaultProfile]?.path ?? "profiles/default";
  const upload = await collectProfileSourceUploadEntries(state.repoPath);
  const result = await client.profile.push({
    teamId,
    entries: upload.entries,
    branch: state.git.branch ?? "main",
    commitMessage:
      optionString(options, "commitMessage") ||
      optionString(options, "message") ||
      `Push OpenPond profile ${state.activeProfile ?? "default"} at ${state.git.shortHead ?? state.git.head}`,
    expectedSourceCommitSha: currentHostedHead,
    localHeadSha: state.git.head,
    manifest,
    sourcePath,
    agents: state.agents.map((agent) => ({
      id: agent.id,
      path: agent.path,
      enabled: agent.enabled,
    })),
  });
  const pushedAt = new Date().toISOString();
  const pushStatus: LocalOpenPondProfilePushStatus = {
    status: "pushed",
    promotionStatus: "uploaded",
    hostedRunStatus: "not_started",
    pushedAt,
    teamId,
    projectId: result.profile.project.id,
    localHead: state.git.head,
    hostedHead: result.sourceUpload.sourceCommitSha,
    sourceRef: result.sourceUpload.sourceRef,
  };
  await saveProfilePushStatus(pushStatus);

  const hostedRunAgentId = optionString(options, "hostedRunAgentId");
  let hostedRun:
    | Awaited<ReturnType<typeof client.agents.run>>
    | null = null;
  if (hostedRunAgentId) {
    const hostedRunStartedAt = new Date().toISOString();
    await saveProfilePushStatus({
      ...pushStatus,
      promotionStatus: "hosted_run_pending",
      hostedRunStatus: "running",
      hostedRunAgentId,
      hostedRunAt: hostedRunStartedAt,
    });
    try {
      hostedRun = await client.agents.run(hostedRunAgentId, {
        teamId,
        idempotencyKey: `profile-push-run:${state.git.head}:${hostedRunAgentId}`,
        input:
          parseJsonObjectOption(options, "hostedRunInput") ??
          { prompt: "hello", channel: "openpond_chat" },
        metadata: {
          source: "openpond_profile_push_run",
          localHead: state.git.head,
          hostedHead: result.sourceUpload.sourceCommitSha,
          sourceRef: result.sourceUpload.sourceRef,
        },
        runtimeSourcePolicy: {
          allowLatestSource: true,
          source: "diagnostic",
        },
      });
      await saveProfilePushStatus({
        ...pushStatus,
        promotionStatus: "hosted_run_pending",
        hostedRunStatus: "running",
        hostedRunAgentId,
        hostedRunId: hostedRun.run.id,
        hostedRunAt: hostedRun.run.createdAt ?? hostedRunStartedAt,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await saveProfilePushStatus({
        ...pushStatus,
        promotionStatus: "hosted_run_failed",
        hostedRunStatus: "failed",
        hostedRunAgentId,
        hostedRunAt: new Date().toISOString(),
        error: message,
      });
      throw new Error(`Hosted invocation failed to start after push: ${message}`);
    }
  }

  if (parseBooleanOption(options.json)) {
    console.log(JSON.stringify({ ...result, uploaded: upload, hostedRun }, null, 2));
    return;
  }
  console.log(`Pushed OpenPond profile ${state.activeProfile ?? "default"} to hosted profile repo.`);
  console.log(`Project id: ${result.profile.project.id}`);
  console.log(`Local head: ${state.git.head}`);
  console.log(`Hosted source commit: ${result.sourceUpload.sourceCommitSha ?? "unknown"}`);
  console.log(
    `Uploaded ${upload.fileCount} file(s), ${upload.totalBytes} byte(s) via ${upload.transport.mode} ` +
      `(limits: ${upload.limits.maxFiles} files, ${upload.limits.maxFileBytes} bytes/file, ${upload.limits.maxTotalBytes} bytes total).`
  );
  console.log(
    hostedRun
      ? `Hosted invocation: running ${hostedRun.run.id}`
      : "Hosted invocation: not started"
  );
  console.log(`Uploaded files: ${upload.fileCount}`);
}

async function runHostedProfileStatusCommand(options: CliOptions): Promise<void> {
  const teamId = requiredTeamId(
    options,
    "usage: openpond profile hosted status",
  );
  const client = await resolveSandboxClient(options);
  const profile = await client.profile.get({ teamId });
  if (parseBooleanOption(options.json)) {
    console.log(JSON.stringify({ profile }, null, 2));
    return;
  }
  if (!profile) {
    console.log("No hosted OpenPond profile repo found.");
    console.log("Run `openpond profile ensure-hosted --team-id <id>` to create one.");
    return;
  }
  printHostedProfileSummary(profile);
}

async function runHostedProfileEnsureCommand(options: CliOptions): Promise<void> {
  const teamId = requiredTeamId(
    options,
    "usage: openpond profile ensure-hosted",
  );
  const client = await resolveSandboxClient(options);
  const profile = await client.profile.ensureHosted({ teamId });
  if (parseBooleanOption(options.json)) {
    console.log(JSON.stringify({ profile }, null, 2));
    return;
  }
  printHostedProfileSummary(profile);
}

export async function runOpenPondAgentsCommand(options: CliOptions, rest: string[]): Promise<void> {
  const subcommand = rest[0] ?? "list";
  if (subcommand !== "list") {
    throw new Error("usage: openpond agents list [--json]");
  }
  const state = await loadOpenPondProfileState();
  if (state.error) throw new Error(state.error);
  if (parseBooleanOption(options.json)) {
    console.log(JSON.stringify({ agents: state.agents, profile: state }, null, 2));
    return;
  }
  if (state.mode === "none") {
    console.log("No active OpenPond profile. Run `openpond init`.");
    return;
  }
  if (state.agents.length === 0) {
    console.log(`No agents found in ${state.activeProfile}.`);
    return;
  }
  for (const agent of state.agents) {
    console.log(`${agent.id}\t${agent.enabled ? "enabled" : "disabled"}\t${agent.path}`);
  }
}

export async function runOpenPondProfileSdkAlias(
  command: "inspect" | "build" | "validate" | "eval" | "run",
  options: CliOptions,
  rest: string[],
): Promise<void> {
  const cwd = optionString(options, "cwd");
  const args = [...rest, ...optionArgs(options, new Set(["cwd", "account", "profile", "handle", "baseUrl"]))];
  await runProfileSdkCommand({
    command,
    cwd: cwd ? path.resolve(cwd) : undefined,
    args,
    inherit: true,
  });
}

function printProfileState(state: Awaited<ReturnType<typeof loadOpenPondProfileState>>): void {
  if (state.mode === "none") {
    console.log("No active OpenPond profile.");
    console.log(`Default location: ${defaultLocalProfileRepoPath()}`);
    return;
  }
  console.log(`Mode: ${state.mode}`);
  console.log(`Repo: ${state.repoPath}`);
  console.log(`Profile: ${state.activeProfile}`);
  console.log(`Source: ${state.sourcePath ?? "missing"}`);
  console.log(`State: ${state.summary.message}`);
  if (state.git) {
    console.log(`Git: ${state.git.branch ?? "detached"} ${state.git.shortHead ?? "no-head"}${state.git.dirty ? " dirty" : " clean"}`);
    if (state.git.upstream) {
      console.log(`Upstream: ${state.git.upstream} ahead ${state.git.ahead ?? "?"} behind ${state.git.behind ?? "?"}`);
    }
  }
  if (state.hosted?.projectId || state.hosted?.sourceCommitSha) {
    console.log(`Hosted: ${state.hosted.projectId ?? "unbound"} ${state.hosted.sourceCommitSha ?? "no-source-head"}`);
  }
  console.log(`Catalog: ${state.catalog.actionCount} action(s)${state.catalog.stale ? " stale" : ""}`);
  console.log(
    `Setup gate: ${state.setupGate.status} (${state.setupGate.blockingCount} blocking, ${state.setupGate.optionalMissingCount} optional missing)`,
  );
  if (state.summary.defaultAction) {
    console.log(`Default action: ${state.summary.defaultAction}`);
  }
  if (state.setupGate.blockingRequirements.length > 0) {
    console.log("Blocking setup:");
    for (const requirement of state.setupGate.blockingRequirements.slice(0, 10)) {
      console.log(`  ${formatOpenPondProfileSetupRequirement(requirement)}`);
    }
    if (state.setupGate.blockingRequirements.length > 10) {
      console.log(`  ... ${state.setupGate.blockingRequirements.length - 10} more`);
    }
  }
  if (!state.summary.checkFresh && state.summary.checkStaleReason) {
    console.log(`Checks: stale - ${state.summary.checkStaleReason}`);
  } else if (state.summary.checkFresh) {
    console.log("Checks: fresh");
  }
  if (state.lastCheck) {
    console.log(`Last check: ${state.lastCheck.command} ${state.lastCheck.status} at ${state.lastCheck.checkedAt}`);
  }
  if (state.error) {
    console.log(`Error: ${state.error}`);
  }
  if (state.agents.length > 0) {
    console.log("Agents:");
    for (const agent of state.agents) {
      console.log(`  ${agent.id} (${agent.enabled ? "enabled" : "disabled"}) ${agent.path}`);
    }
  }
}

function printProfileDiff(state: Awaited<ReturnType<typeof loadOpenPondProfileState>>): void {
  if (state.mode === "none") {
    console.log("No active OpenPond profile.");
    return;
  }
  console.log(`Profile: ${state.activeProfile}`);
  console.log(`State: ${state.summary.message}`);
  const groups: Array<[string, string[]]> = [
    ["Changed agents", state.diff.changedAgents],
    ["New agents", state.diff.newAgents],
    ["Deleted agents", state.diff.deletedAgents],
    ["Changed actions", state.diff.changedActions],
    ["Changed extensions", state.diff.changedExtensions],
    ["Setup changes", state.diff.setupChanges],
    ["Env requirement changes", state.diff.envRequirementChanges],
  ];
  for (const [label, values] of groups) {
    if (values.length === 0) continue;
    console.log(`${label}: ${values.join(", ")}`);
  }
  if (state.diff.files.length === 0) {
    console.log("No source changes.");
    return;
  }
  console.log("Files:");
  for (const file of state.diff.files) {
    console.log(`  ${file.status.padEnd(2)} ${file.path}`);
  }
}

function printProfileCatalog(state: Awaited<ReturnType<typeof loadOpenPondProfileState>>): void {
  if (state.mode === "none") {
    console.log("No active OpenPond profile.");
    return;
  }
  console.log(`Profile: ${state.activeProfile}`);
  console.log(`Catalog: ${state.catalog.actionCount} action(s)${state.catalog.stale ? " stale" : ""}`);
  console.log(
    `Setup gate: ${state.setupGate.status} (${state.setupGate.blockingCount} blocking, ${state.setupGate.optionalMissingCount} optional missing)`,
  );
  if (state.catalog.generatedAt) console.log(`Generated at: ${state.catalog.generatedAt}`);
  if (state.catalog.error) console.log(`Catalog error: ${state.catalog.error}`);
  if (state.actionCatalog.length === 0) {
    console.log("No catalog actions found. Run `openpond inspect` or `openpond build`.");
    return;
  }
  for (const action of state.actionCatalog) {
    const label = action.label ?? action.name ?? action.id;
    const visibility = action.visibility ?? "default";
    const actionBlocking = state.setupGate.blockingRequirements.filter(
      (requirement) => requirement.actionId === action.id,
    );
    const setup = actionBlocking.length
      ? `setup_required:${actionBlocking.map((requirement) => requirement.label).join(",")}`
      : "setup_ready";
    console.log(`${action.id}\t${visibility}\t${setup}\t${label}`);
  }
  const sourceBlocking = state.setupGate.blockingRequirements.filter(
    (requirement) => requirement.actionId === null,
  );
  if (sourceBlocking.length > 0) {
    console.log("Source setup blockers:");
    for (const requirement of sourceBlocking) {
      console.log(`  ${formatOpenPondProfileSetupRequirement(requirement)}`);
    }
  }
}

function printHostedProfileSummary(profile: OpenPondHostedProfileSummary): void {
  console.log(`Hosted profile repo: ${profile.project.name}`);
  console.log(`Project id: ${profile.project.id}`);
  console.log(`Role: ${profile.project.role ?? "profile"}`);
  console.log(`Default profile: ${profile.defaultProfile}`);
  console.log(`Source path: ${profile.sourcePath}`);
  console.log(`Seed status: ${profile.seedStatus}`);
  if (profile.sourceUpload?.sourceRef) {
    console.log(`Source ref: ${profile.sourceUpload.sourceRef}`);
  }
  if (profile.sourceUpload?.sourceCommitSha) {
    console.log(`Source commit: ${profile.sourceUpload.sourceCommitSha}`);
  }
  if (profile.seededAt) {
    console.log(`Seeded at: ${profile.seededAt}`);
  }
  if (profile.agents.length > 0) {
    console.log("Agents:");
    for (const agent of profile.agents) {
      console.log(`  ${agent.id} (${agent.enabled ? "enabled" : "disabled"}) ${agent.path}`);
    }
  }
}

function optionArgs(options: CliOptions, ignored: Set<string>): string[] {
  const args: string[] = [];
  const booleanFlags = new Set(["force", "json"]);
  for (const [key, value] of Object.entries(options)) {
    if (ignored.has(key)) continue;
    const flag = `--${key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`;
    if (value === true || (booleanFlags.has(key) && value === "true")) {
      args.push(flag);
    } else if (booleanFlags.has(key) && value === "false") {
      continue;
    } else if (typeof value === "string") {
      args.push(flag, value);
    }
  }
  return args;
}

function parseJsonObjectOption(
  options: CliOptions,
  key: string
): Record<string, unknown> | null {
  const raw = optionString(options, key);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`--${key} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}
