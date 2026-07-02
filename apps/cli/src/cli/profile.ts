import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  collectProfileSourceUploadEntries,
  commitActiveProfileChanges,
  defaultLocalProfileRepoPath,
  formatOpenPondProfileSetupRequirement,
  hostedPublishStatusFromPayload,
  hostedRunStatusFromRunSummary,
  hostedRunSummaryFromPayload,
  hostedSourceCheckStatusFromPayload,
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
import {
  collectAgentSdkProjectSourceUploadEntries,
  collectProjectSourceUploadEntries,
  mergeProjectSourceUploadEntries,
} from "./project-source-upload";
import { parseAgentSourceCheckDispatch } from "./project-agent-inputs";
import type { OpenPondHostedProfileSummary } from "../sandbox/types/index";

type CliOptions = Record<string, string | boolean>;
type LoadedOpenPondProfileState = Awaited<ReturnType<typeof loadOpenPondProfileState>>;

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
  const preserveHostedPromotionEvidence =
    state.hosted?.lastPushedLocalHead === state.git.head &&
    state.hosted?.sourceCommitSha === result.sourceUpload.sourceCommitSha;
  let pushStatus: LocalOpenPondProfilePushStatus = {
    status: "pushed",
    promotionStatus: preserveHostedPromotionEvidence
      ? state.hosted?.promotionStatus ?? "uploaded"
      : "uploaded",
    hostedRunStatus: preserveHostedPromotionEvidence
      ? (state.hosted?.hostedRunStatus as LocalOpenPondProfilePushStatus["hostedRunStatus"]) ?? "not_started"
      : "not_started",
    pushedAt,
    teamId,
    projectId: result.profile.project.id,
    localHead: state.git.head,
    hostedHead: result.sourceUpload.sourceCommitSha,
    sourceRef: result.sourceUpload.sourceRef,
    hostedRunAgentId: preserveHostedPromotionEvidence ? state.hosted?.hostedRunAgentId ?? null : null,
    hostedRunId: preserveHostedPromotionEvidence ? state.hosted?.hostedRunId ?? null : null,
    hostedRunAt: preserveHostedPromotionEvidence ? state.hosted?.hostedRunAt ?? null : null,
    hostedSourceMaterialization: preserveHostedPromotionEvidence ? state.hosted?.hostedSourceMaterialization ?? null : null,
    hostedSourceCheck: preserveHostedPromotionEvidence ? state.hosted?.hostedSourceCheck ?? null : null,
    hostedPublish: preserveHostedPromotionEvidence ? state.hosted?.hostedPublish ?? null : null,
    hostedRun: preserveHostedPromotionEvidence ? state.hosted?.hostedRun ?? null : null,
  };
  await saveProfilePushStatus(pushStatus);

  const explicitHostedSourceAgentId = optionString(options, "hostedSourceAgentId");
  const requestHostedSourceChecks = parseBooleanOption(options.hostedSourceChecks);
  const publishHostedSource = parseBooleanOption(options.publishHostedSource);
  const hostedRunAgentId = optionString(options, "hostedRunAgentId");
  const hostedSourceAgentId =
    explicitHostedSourceAgentId ||
    (requestHostedSourceChecks || publishHostedSource ? hostedRunAgentId : null);
  let hostedRuntimeAgentId =
    hostedSourceAgentId ??
    resolveHostedRuntimeAgentIdForRun(state, hostedRunAgentId);
  const hostedSourceDispatch =
    parseAgentSourceCheckDispatch(
      options.hostedSourceDispatch,
      "hosted-source-dispatch"
    ) ?? "coding_core";
  let hostedSourceDeployPlan:
    | Awaited<ReturnType<typeof client.agents.sourceDeployPlan>>
    | null = null;
  let hostedSourceChecks:
    | Awaited<ReturnType<typeof client.agents.requestSourceChecks>>
    | null = null;
  let hostedSourcePublish:
    | Awaited<ReturnType<typeof client.agents.publishSource>>
    | null = null;

  if (hostedSourceAgentId && (requestHostedSourceChecks || publishHostedSource || explicitHostedSourceAgentId)) {
    try {
      const hostedSourceMaterialization = await materializeHostedProfileAgentSource({
        client,
        teamId,
        profileProjectId: result.profile.project.id,
        profileName: state.activeProfile ?? manifest.defaultProfile,
        state,
        agentId: hostedSourceAgentId,
        sourceRef: result.sourceUpload.sourceRef ?? state.git.branch ?? "main",
        localHead: state.git.head,
        hostedHead: result.sourceUpload.sourceCommitSha,
        projectId:
          optionString(options, "hostedSourceProjectId") ||
          (state.hosted?.hostedSourceMaterialization?.agentId === hostedSourceAgentId
            ? state.hosted.hostedSourceMaterialization.projectId
            : null),
      });
      pushStatus = {
        ...pushStatus,
        promotionStatus: "hosted_source_materialized",
        hostedSourceMaterialization,
      };
      hostedRuntimeAgentId = hostedSourceMaterialization.runtimeAgentId ?? hostedSourceAgentId;
      await saveProfilePushStatus(pushStatus);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushStatus = {
        ...pushStatus,
        promotionStatus: "hosted_source_materialize_failed",
        hostedSourceMaterialization: {
          status: "failed",
          agentId: hostedSourceAgentId,
          projectId: optionString(options, "hostedSourceProjectId") ?? null,
          error: message,
        },
        error: message,
      };
      await saveProfilePushStatus(pushStatus);
      throw new Error(`Hosted source materialization failed after push: ${message}`);
    }
  }

  if (requestHostedSourceChecks || publishHostedSource) {
    if (!hostedSourceAgentId) {
      throw new Error("--hosted-source-agent-id or --hosted-run-agent-id is required for hosted source checks or publish.");
    }
    try {
      hostedSourceDeployPlan = await client.agents.sourceDeployPlan(hostedRuntimeAgentId, { teamId });
      if (requestHostedSourceChecks) {
        const sourceRef = pushStatus.hostedSourceMaterialization?.sourceRef ?? result.sourceUpload.sourceRef;
        const baseSha = pushStatus.hostedSourceMaterialization?.sourceCommitSha ?? result.sourceUpload.sourceCommitSha;
        hostedSourceChecks = await client.agents.requestSourceChecks(hostedRuntimeAgentId, {
          teamId,
          ...(sourceRef ? { sourceRef } : {}),
          ...(baseSha ? { baseSha } : {}),
          checkKind: optionString(options, "hostedCheckKind") || optionString(options, "checkKind") || "all",
          dispatch: hostedSourceDispatch,
          metadata: {
            source: "openpond_profile_push_checks",
            localHead: state.git.head,
            hostedHead: result.sourceUpload.sourceCommitSha,
            materializedProjectId: pushStatus.hostedSourceMaterialization?.projectId ?? null,
            materializedSourceCommitSha: pushStatus.hostedSourceMaterialization?.sourceCommitSha ?? null,
            sourceRef,
            dispatch: hostedSourceDispatch,
          },
        });
        if (hostedSourceChecks.dispatchResult?.status === "failed") {
          throw new Error(hostedSourceChecks.dispatchResult.error ?? "hosted_source_check_dispatch_failed");
        }
        if (hostedSourceChecks.dispatchResult?.status === "completed") {
          const refreshed = await refreshHostedSourceCheckStatus({
            client,
            teamId,
            checkResult: hostedSourceChecks,
          });
          if (refreshed) {
            hostedSourceChecks = refreshed as typeof hostedSourceChecks;
          }
          const sourceCheckStatus = record((hostedSourceChecks as Record<string, unknown>).sourceCheckStatus);
          if (sourceCheckStatusPassed(sourceCheckStatus)) {
            await bindValidatedHostedRuntimeSource({
              client,
              teamId,
              runtimeAgentId: hostedRuntimeAgentId,
              sourceRef,
              sourceCommitSha: baseSha,
              validatedAt: new Date().toISOString(),
            });
            hostedSourceDeployPlan = await client.agents.sourceDeployPlan(hostedRuntimeAgentId, { teamId });
          }
        }
      }
      pushStatus = {
        ...pushStatus,
        promotionStatus: requestHostedSourceChecks ? "hosted_source_check_pending" : pushStatus.promotionStatus,
        hostedSourceCheck: hostedSourceCheckStatusFromPayload({
          agentId: hostedRuntimeAgentId,
          status: requestHostedSourceChecks ? "requested" : "deploy_plan_ready",
          deployPlan: hostedSourceDeployPlan,
          checkResult: hostedSourceChecks,
        }),
      };
      await saveProfilePushStatus(pushStatus);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushStatus = {
        ...pushStatus,
        promotionStatus: "hosted_source_check_failed",
        hostedSourceCheck: hostedSourceCheckStatusFromPayload({
          agentId: hostedRuntimeAgentId,
          status: "failed",
          deployPlan: hostedSourceDeployPlan,
          checkedAt: new Date().toISOString(),
          error: message,
        }),
        error: message,
      };
      await saveProfilePushStatus(pushStatus);
      throw new Error(`Hosted source check failed after push: ${message}`);
    }
  }

  if (publishHostedSource) {
    if (!hostedSourceAgentId) {
      throw new Error("--hosted-source-agent-id or --hosted-run-agent-id is required for hosted source publish.");
    }
    try {
      const expectedManifestHash =
        optionString(options, "expectedManifestHash") ||
        pushStatus.hostedSourceCheck?.manifestHash ||
        hostedSourceDeployPlan?.source.manifestHash ||
        undefined;
      hostedSourcePublish = await client.agents.publishSource(hostedRuntimeAgentId, {
        teamId,
        ...(expectedManifestHash ? { expectedManifestHash } : {}),
        ...(pushStatus.hostedSourceMaterialization?.sourceCommitSha ?? result.sourceUpload.sourceCommitSha
          ? { expectedSourceCommitSha: pushStatus.hostedSourceMaterialization?.sourceCommitSha ?? result.sourceUpload.sourceCommitSha }
          : {}),
        ...(optionString(options, "workItemId") ? { workItemId: optionString(options, "workItemId") } : {}),
      });
      pushStatus = {
        ...pushStatus,
        promotionStatus: "hosted_source_published",
        hostedPublish: hostedPublishStatusFromPayload({
          agentId: hostedRuntimeAgentId,
          publishResult: hostedSourcePublish,
        }),
      };
      await saveProfilePushStatus(pushStatus);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushStatus = {
        ...pushStatus,
        promotionStatus: "hosted_source_publish_failed",
        hostedPublish: {
          status: "failed",
          agentId: hostedRuntimeAgentId,
          error: message,
        },
        error: message,
      };
      await saveProfilePushStatus(pushStatus);
      throw new Error(`Hosted source publish failed after push: ${message}`);
    }
  }

  let hostedRun:
    | Awaited<ReturnType<typeof client.agents.run>>
    | null = null;
  if (hostedRunAgentId) {
    const hostedRunRuntimeAgentId = hostedRuntimeAgentId || hostedRunAgentId;
    const hostedRunStartedAt = new Date().toISOString();
    const hostedRunInput =
      parseJsonObjectOption(options, "hostedRunInput") ??
      { prompt: "hello", channel: "openpond_chat" };
    const hostedRunConversationId =
      optionString(options, "hostedRunConversationId") ||
      optionString(options, "conversationId");
    const hostedRunIdempotencyKey = buildHostedRunIdempotencyKey({
      options,
      localHead: state.git.head,
      hostedHead: result.sourceUpload.sourceCommitSha,
      runtimeAgentId: hostedRunRuntimeAgentId,
      materializedSourceCommitSha: pushStatus.hostedSourceMaterialization?.sourceCommitSha ?? null,
      input: hostedRunInput,
    });
    await saveProfilePushStatus({
      ...pushStatus,
      promotionStatus: "hosted_run_pending",
      hostedRunStatus: "running",
      hostedRunAgentId: hostedRunRuntimeAgentId,
      hostedRunAt: hostedRunStartedAt,
    });
    try {
      hostedRun = await client.agents.run(hostedRunRuntimeAgentId, {
        teamId,
        ...(hostedRunConversationId ? { conversationId: hostedRunConversationId } : {}),
        idempotencyKey: hostedRunIdempotencyKey,
        input: hostedRunInput,
        metadata: {
          source: "openpond_profile_push_run",
          ...(hostedRunConversationId ? { conversationId: hostedRunConversationId } : {}),
          localHead: state.git.head,
          hostedHead: result.sourceUpload.sourceCommitSha,
          hostedRunIdempotencyKey,
          hostedRunRetry: parseBooleanOption(options.hostedRunRetry),
          materializedProjectId: pushStatus.hostedSourceMaterialization?.projectId ?? null,
          materializedSourceCommitSha: pushStatus.hostedSourceMaterialization?.sourceCommitSha ?? null,
          sourceRef: pushStatus.hostedSourceMaterialization?.sourceRef ?? result.sourceUpload.sourceRef,
          publishedSnapshotId: pushStatus.hostedPublish?.snapshotId ?? null,
          manifestHash:
            pushStatus.hostedPublish?.manifestHash ??
            pushStatus.hostedSourceCheck?.manifestHash ??
            null,
        },
        runtimeSourcePolicy: publishHostedSource
          ? {
              requirePublishedSnapshot: true,
              source: "diagnostic",
            }
          : {
              allowLatestSource: true,
              source: "diagnostic",
            },
      });
      const hostedRunSummary = hostedRunSummaryFromPayload({
        agentId: hostedRunRuntimeAgentId,
        runResult: hostedRun,
      });
      const hostedRunStatus = hostedRunStatusFromRunSummary(hostedRunSummary);
      await saveProfilePushStatus({
        ...pushStatus,
        promotionStatus:
          hostedRunStatus === "passed"
            ? "hosted_run_passed"
            : hostedRunStatus === "failed"
              ? "hosted_run_failed"
              : "hosted_run_pending",
        hostedRunStatus,
        hostedRunAgentId: hostedRunRuntimeAgentId,
        hostedRunId: hostedRun.run.id,
        hostedRunAt: hostedRun.run.createdAt ?? hostedRunStartedAt,
        hostedRun: hostedRunSummary,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await saveProfilePushStatus({
        ...pushStatus,
        promotionStatus: "hosted_run_failed",
        hostedRunStatus: "failed",
        hostedRunAgentId: hostedRunRuntimeAgentId,
        hostedRunAt: new Date().toISOString(),
        hostedRun: {
          status: "failed",
          agentId: hostedRunRuntimeAgentId,
          error: message,
        },
        error: message,
      });
      throw new Error(`Hosted invocation failed to start after push: ${message}`);
    }
  }

  if (parseBooleanOption(options.json)) {
    console.log(
      JSON.stringify(
        {
          ...result,
          uploaded: summarizeProfileSourceUpload(upload),
          hostedSourceMaterialization: pushStatus.hostedSourceMaterialization ?? null,
          hostedSourceChecks,
          hostedSourcePublish,
          hostedRun,
        },
        null,
        2
      )
    );
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
  if (pushStatus.hostedSourceMaterialization) {
    console.log(
      `Hosted materialized: ${pushStatus.hostedSourceMaterialization.status}` +
        (pushStatus.hostedSourceMaterialization.projectId ? ` ${pushStatus.hostedSourceMaterialization.projectId}` : "") +
        (pushStatus.hostedSourceMaterialization.sourceCommitSha ? ` ${pushStatus.hostedSourceMaterialization.sourceCommitSha}` : "")
    );
  }
  if (pushStatus.hostedSourceCheck) {
    console.log(
      `Hosted source checks: ${pushStatus.hostedSourceCheck.status}` +
        (pushStatus.hostedSourceCheck.workItemId ? ` ${pushStatus.hostedSourceCheck.workItemId}` : "")
    );
  }
  if (pushStatus.hostedPublish) {
    console.log(
      `Hosted publish: ${pushStatus.hostedPublish.status}` +
        (pushStatus.hostedPublish.snapshotId ? ` ${pushStatus.hostedPublish.snapshotId}` : "")
    );
  }
  console.log(`Uploaded files: ${upload.fileCount}`);
}

function summarizeProfileSourceUpload(upload: Awaited<ReturnType<typeof collectProfileSourceUploadEntries>>) {
  return {
    fileCount: upload.fileCount,
    totalBytes: upload.totalBytes,
    limits: upload.limits,
    transport: upload.transport,
  };
}

async function materializeHostedProfileAgentSource(input: {
  client: Awaited<ReturnType<typeof resolveSandboxClient>>;
  teamId: string;
  profileProjectId: string;
  profileName: string;
  state: LoadedOpenPondProfileState;
  agentId: string;
  sourceRef: string;
  localHead: string | null;
  hostedHead: string | null;
  projectId?: string | null;
}): Promise<NonNullable<LocalOpenPondProfilePushStatus["hostedSourceMaterialization"]>> {
  if (!input.state.sourcePath) {
    throw new Error("Active OpenPond profile is missing a source path.");
  }
  const agent = input.state.agents.find((candidate) => candidate.id === input.agentId);
  if (!agent) {
    throw new Error(`Profile agent not found for hosted materialization: ${input.agentId}`);
  }

  const sourceRoot = resolveProfileAgentSourceRoot(input.state.sourcePath, agent.path);
  const collected = await collectProjectSourceUploadEntries(sourceRoot);
  const agentSdk = await collectAgentSdkProjectSourceUploadEntries(sourceRoot, collected.entries);
  const upload = mergeProjectSourceUploadEntries(collected, agentSdk.entries);

  const materializationProject = await getOrCreateHostedSourceProject({
    client: input.client,
    teamId: input.teamId,
    projectId: input.projectId ?? null,
    profileProjectId: input.profileProjectId,
    profileName: input.profileName,
    agentId: input.agentId,
    localHead: input.localHead,
    hostedHead: input.hostedHead,
  });
  const uploadedProject = await input.client.projects.uploadSource(materializationProject.id, {
    teamId: input.teamId,
    entries: upload.entries,
    branch: input.sourceRef,
    commitMessage: `Materialize OpenPond profile agent ${input.agentId}`,
  });
  const syncedProject = await input.client.projects.sync(uploadedProject.id, {
    teamId: input.teamId,
  });
  const sourceCommitSha =
    sandboxProjectSourceCommitSha(syncedProject) ??
    sandboxProjectSourceCommitSha(uploadedProject);
  const sourceRef =
    sandboxProjectSourceRef(syncedProject) ??
    sandboxProjectSourceRef(uploadedProject) ??
    input.sourceRef;
  const selectedEntrypoint = hostedEntrypointForProfileAgent(input.state, input.agentId);
  const runtimeAgent = await input.client.agents.upsert({
    teamId: input.teamId,
    projectId: syncedProject.id,
    name: agent.name || input.agentId,
    slug: hostedRuntimeAgentSlug(input.profileName, input.agentId),
    selectedEntrypoint,
    triggerType: "manual",
    runtimeSource: {
      mode: "latest_source",
      ...(sourceRef ? { sourceRef } : {}),
      ...(sourceCommitSha ? { sourceCommitSha } : {}),
    },
    metadata: {
      source: "openpond_profile_agent_materialization",
      profileProjectId: input.profileProjectId,
      profileName: input.profileName,
      profileAgentId: input.agentId,
      profileSourcePath: agent.path,
      localHead: input.localHead,
      hostedHead: input.hostedHead,
    },
    externalId: `openpond-profile-agent:${input.profileProjectId}:${input.profileName}:${input.agentId}`,
  });

  const uploadMetadata = record(agentSdk.uploadMetadata);
  const commands = record(uploadMetadata?.commands);
  const dependencySetup = record(uploadMetadata?.dependencySetup);
  const setupCommands = stringArray(dependencySetup?.commands);
  const validationCommands = [
    text(commands?.validate),
    text(commands?.eval),
  ].filter((command): command is string => Boolean(command));

  return {
    status: "uploaded",
    agentId: input.agentId,
    runtimeAgentId: runtimeAgent.id,
    projectId: syncedProject.id,
    sourceRoot,
    sourceRef,
    sourceCommitSha: sourceCommitSha ?? null,
    manifestHash: syncedProject.sandboxManifestHash ?? null,
    manifestPath: syncedProject.sandboxManifestPath ?? null,
    manifestSyncedAt: syncedProject.sandboxManifestSyncedAt ?? null,
    fileCount: upload.fileCount,
    totalBytes: upload.totalBytes,
    generatedManifestPath: agentSdk.generatedManifestPath,
    synthesizedOpenPondYaml: agentSdk.synthesizedOpenPondYaml,
    uploadMetadataPath: agentSdk.uploadMetadataPath,
    setupCommands,
    validationCommands,
    materializedAt: new Date().toISOString(),
  };
}

async function getOrCreateHostedSourceProject(input: {
  client: Awaited<ReturnType<typeof resolveSandboxClient>>;
  teamId: string;
  projectId: string | null;
  profileProjectId: string;
  profileName: string;
  agentId: string;
  localHead: string | null;
  hostedHead: string | null;
}) {
  if (input.projectId) {
    try {
      return await input.client.projects.get(input.projectId, {
        teamId: input.teamId,
      });
    } catch {
      // Fall through to upsert when a previously recorded materialization project was deleted.
    }
  }
  return input.client.projects.upsert({
    teamId: input.teamId,
    name: `OpenPond profile ${input.profileName} ${input.agentId}`,
    sourceType: "manual",
    externalId: `openpond-profile:${input.profileProjectId}:${input.profileName}:${input.agentId}`,
    description: `Materialized OpenPond profile agent ${input.agentId} for hosted sandbox checks.`,
    metadata: {
      source: "openpond_profile_agent_materialization",
      profileProjectId: input.profileProjectId,
      profileName: input.profileName,
      profileAgentId: input.agentId,
      localHead: input.localHead,
      hostedHead: input.hostedHead,
    },
  });
}

function resolveProfileAgentSourceRoot(sourcePath: string, agentPath: string): string {
  const normalized = agentPath.replace(/\\/g, "/");
  const absolute = path.resolve(sourcePath, normalized);
  const relative = path.relative(sourcePath, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Profile agent path escapes profile source: ${agentPath}`);
  }
  return normalized === "agent/agent.ts" || normalized.endsWith("/agent.ts")
    ? sourcePath
    : absolute;
}

function hostedEntrypointForProfileAgent(
  state: LoadedOpenPondProfileState,
  agentId: string
) {
  const action =
    state.actionCatalog.find(
      (candidate) =>
        candidate.agentId === agentId &&
        (candidate.sourceActionId === "chat" || candidate.name === "chat")
    ) ??
    state.actionCatalog.find((candidate) => candidate.agentId === agentId);
  return {
    scope: "action" as const,
    name:
      (typeof action?.sourceActionId === "string" && action.sourceActionId) ||
      (typeof action?.name === "string" && action.name) ||
      "chat",
  };
}

function hostedRuntimeAgentSlug(profileName: string, agentId: string): string {
  const slug = `openpond-profile-${profileName}-${agentId}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "openpond-profile-agent";
}

function sandboxProjectSourceCommitSha(project: unknown): string | null {
  const item = record(project);
  const sourceConfig = record(item?.sourceConfig);
  const metadata = record(item?.metadata);
  return (
    text(sourceConfig?.sourceCommitSha) ??
    text(sourceConfig?.commitSha) ??
    text(sourceConfig?.remoteSha) ??
    text(metadata?.projectSourceUploadCommitSha) ??
    text(metadata?.sourceCommitSha) ??
    text(item?.templateRemoteSha)
  );
}

function sandboxProjectSourceRef(project: unknown): string | null {
  const item = record(project);
  const sourceConfig = record(item?.sourceConfig);
  return (
    text(sourceConfig?.sourceRef) ??
    text(sourceConfig?.branch) ??
    text(item?.gitBranch) ??
    text(item?.defaultBranch)
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function resolveHostedRuntimeAgentIdForRun(
  state: LoadedOpenPondProfileState,
  hostedRunAgentId: string | null
): string | null {
  if (!hostedRunAgentId) return null;
  const materialization = state.hosted?.hostedSourceMaterialization;
  if (
    materialization?.agentId === hostedRunAgentId &&
    materialization.runtimeAgentId
  ) {
    return materialization.runtimeAgentId;
  }
  return hostedRunAgentId;
}

async function refreshHostedSourceCheckStatus(input: {
  client: Awaited<ReturnType<typeof resolveSandboxClient>>;
  teamId: string;
  checkResult: Awaited<ReturnType<Awaited<ReturnType<typeof resolveSandboxClient>>["agents"]["requestSourceChecks"]>>;
}): Promise<Record<string, unknown> | null> {
  const workItemId = text(record(input.checkResult.workItem)?.id);
  if (!workItemId) return null;
  const status = await input.client.workItems.status(workItemId, {
    teamId: input.teamId,
    includeArchived: true,
    limit: 50,
  });
  return {
    ...input.checkResult,
    workItem: status.workItem,
    activity: status.activity,
    sourceCheckStatus: status.sourceCheckStatus,
  };
}

async function bindValidatedHostedRuntimeSource(input: {
  client: Awaited<ReturnType<typeof resolveSandboxClient>>;
  teamId: string;
  runtimeAgentId: string;
  sourceRef: string | null;
  sourceCommitSha: string | null;
  validatedAt: string;
}): Promise<void> {
  if (!input.sourceRef || !input.sourceCommitSha) return;
  await input.client.agents.update(input.runtimeAgentId, {
    teamId: input.teamId,
    runtimeSource: {
      mode: "latest_source",
      sourceRef: input.sourceRef,
      sourceCommitSha: input.sourceCommitSha,
      buildStatus: "succeeded",
      validationStatus: "passed",
      validatedAt: input.validatedAt,
    },
  });
}

function sourceCheckStatusPassed(status: Record<string, unknown> | null): boolean {
  if (!status) return false;
  const finalResultState = text(status.finalResultState)?.toLowerCase();
  if (
    finalResultState &&
    finalResultState !== "completed" &&
    !passingStatus(finalResultState)
  ) {
    return false;
  }

  const checkRuns = Array.isArray(status.checkRuns)
    ? status.checkRuns.map(record).filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
  if (checkRuns.some(checkRunFailed)) return false;

  const buildPassed = checkRuns.some(
    (run) => checkRunCommand(run).includes("build") && checkEvidencePassed(run)
  );
  const validationPassed =
    checkEvidencePassed(record(status.validation)) ||
    checkRuns.some(
      (run) => checkRunCommand(run).includes("validate") && checkEvidencePassed(run)
    );
  const evalEvidence = record(status.eval);
  const evalRequired =
    (text(status.requestedCheckKind) ?? "all") === "all" ||
    (text(status.requestedCheckKind) ?? "") === "eval" ||
    Boolean(evalEvidence) ||
    checkRuns.some((run) => checkRunCommand(run).includes("eval"));
  const evalPassed =
    !evalRequired ||
    checkEvidencePassed(evalEvidence) ||
    checkRuns.some(
      (run) => checkRunCommand(run).includes("eval") && checkEvidencePassed(run)
    );

  return buildPassed && validationPassed && evalPassed;
}

function checkRunCommand(run: Record<string, unknown>): string {
  return (text(run.command) ?? "").toLowerCase();
}

function checkRunFailed(run: Record<string, unknown>): boolean {
  const passed = run.passed;
  if (typeof passed === "boolean") return !passed;
  const exitCode = run.exitCode;
  if (typeof exitCode === "number" && exitCode !== 0) return true;
  const status = text(run.status)?.toLowerCase();
  return Boolean(status && failingStatus(status));
}

function checkEvidencePassed(evidence: Record<string, unknown> | null): boolean {
  if (!evidence) return false;
  if (typeof evidence.passed === "boolean") return evidence.passed;
  const failed = numericEvidence(evidence.failed) ?? numericEvidence(evidence.failedCount);
  if (failed !== null && failed > 0) return false;
  const exitCode = evidence.exitCode;
  if (typeof exitCode === "number") return exitCode === 0;
  const status = text(evidence.status)?.toLowerCase();
  return Boolean(status && passingStatus(status));
}

function numericEvidence(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function passingStatus(status: string): boolean {
  return status === "passed" || status === "succeeded" || status === "success";
}

function failingStatus(status: string): boolean {
  return status === "failed" || status === "failure" || status === "cancelled";
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
    if (state.hosted.hostedSourceMaterialization) {
      console.log(
        `Hosted materialized: ${state.hosted.hostedSourceMaterialization.status}` +
          (state.hosted.hostedSourceMaterialization.agentId ? ` ${state.hosted.hostedSourceMaterialization.agentId}` : "") +
          (state.hosted.hostedSourceMaterialization.sourceCommitSha ? ` ${state.hosted.hostedSourceMaterialization.sourceCommitSha}` : "")
      );
    }
    if (state.hosted.hostedSourceCheck) {
      console.log(
        `Hosted checks: ${state.hosted.hostedSourceCheck.status}` +
          (state.hosted.hostedSourceCheck.workItemId ? ` ${state.hosted.hostedSourceCheck.workItemId}` : "") +
          (state.hosted.hostedSourceCheck.sandboxId ? ` sandbox ${state.hosted.hostedSourceCheck.sandboxId}` : "")
      );
    }
    if (state.hosted.hostedPublish) {
      console.log(
        `Hosted publish: ${state.hosted.hostedPublish.status}` +
          (state.hosted.hostedPublish.snapshotId ? ` ${state.hosted.hostedPublish.snapshotId}` : "")
      );
    }
    if (state.hosted.hostedRun) {
      console.log(
        `Hosted run: ${state.hosted.hostedRun.status}` +
          (state.hosted.hostedRun.runId ? ` ${state.hosted.hostedRun.runId}` : "") +
          (state.hosted.hostedRun.runtimeId ? ` runtime ${state.hosted.hostedRun.runtimeId}` : "")
      );
    }
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

function buildHostedRunIdempotencyKey(input: {
  options: CliOptions;
  localHead: string;
  hostedHead?: string | null;
  runtimeAgentId: string;
  materializedSourceCommitSha?: string | null;
  input: Record<string, unknown>;
}): string {
  const explicit = optionString(input.options, "hostedRunIdempotencyKey");
  if (explicit) return explicit;
  const sourceHead = input.materializedSourceCommitSha || input.hostedHead || "unknown-source";
  const inputHash = hashStableJson(input.input).slice(0, 16);
  const base = `profile-push-run:${input.localHead}:${sourceHead}:${input.runtimeAgentId}:${inputHash}`;
  return parseBooleanOption(input.options.hostedRunRetry)
    ? `${base}:retry:${randomUUID()}`
    : base;
}

function hashStableJson(value: unknown): string {
  return createHash("sha256").update(stableJsonStringify(value)).digest("hex");
}

function stableJsonStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonStringify(item)).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJsonStringify(item)}`)
    .join(",")}}`;
}
