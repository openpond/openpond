import { readFile } from "node:fs/promises";

import { OpenPondProfileRefSchema, type ProviderSettings, type RuntimeEvent } from "@openpond/contracts";
import { contentHash } from "@openpond/harness";
import {
  collectProfileSourceUploadEntries,
  commitActiveProfileChanges,
  hostedPublishStatusFromPayload,
  buildHostedRunIdempotencyKey,
  hostedRunStatusFromRunSummary,
  hostedRunSummaryFromPayload,
  hostedSourceCheckStatusFromPayload,
  initLocalProfileRepo,
  loadLocalProfileRepo,
  loadOpenPondProfileLibrary,
  loadOpenPondProfileState,
  removeOpenPondProfile,
  renameActiveProfileAgent,
  runProfileCheck,
  runProfileSdkCommand,
  saveProfilePushStatus,
  selectOpenPondProfile,
  type LocalOpenPondProfilePushStatus,
  type ProfileRepoManifest,
} from "@openpond/cloud";
import { event } from "../utils.js";
import {
  resolveOpenPondSandboxClient,
  sandboxRequestPayload,
} from "../openpond/sandboxes.js";
import { materializeHostedProfileAgentSource } from "../openpond/profile-agent-materialization.js";
import {
  asRecord,
  booleanValue,
  nonEmptyRecord,
  parseHostedSourceDispatch,
  profileActionRunSummary,
  stringValue,
} from "./server-payload-helpers.js";
import {
  previewOpenPondProfilePublication,
  publishOpenPondProfile,
} from "../profile-publication.js";
import {
  installOpenPondProfile,
  updateInstalledOpenPondProfile,
} from "../profile-installation.js";
import {
  profileLibraryForClient,
  profileStateForClient,
} from "./client-payload-projection.js";
import type { SqliteStore } from "../store/store.js";
import { ensureLocalProfileWorkflows } from "../harness/local-profile-workflow-runtime.js";
import { profileEvaluationsForRelease } from "../harness/local-profile-evaluation-runtime.js";
import { createProfileEvaluationRunPreparationService } from "../harness/profile-evaluation-run-preparation.js";
import { loadLocalProfileEvaluationTaskset } from "../harness/local-profile-evaluation-taskset.js";
import { createProfileEvaluationComparisonService } from "../harness/profile-evaluation-comparison-service.js";
import { createProfileEvaluationReportService } from "../harness/profile-evaluation-report-service.js";
import { inspectProfileEvaluationRun } from "../harness/profile-evaluation-run-inspection.js";

export function createProfilePayloads(deps: {
  appendRuntimeEvent: (runtimeEvent: RuntimeEvent) => Promise<void>;
  store: SqliteStore;
  storeDir: string;
  providerSettings: () => Promise<ProviderSettings>;
}) {
  const { appendRuntimeEvent } = deps;

  async function profileCurrentPayload() {
    return profileStateForClient(await loadOpenPondProfileState());
  }

  async function profileCatalogPayload() {
    return profileLibraryForClient(await loadOpenPondProfileLibrary());
  }

  async function profileWorkflowsPayload() {
    const [library, profile] = await Promise.all([
      loadOpenPondProfileLibrary(),
      loadOpenPondProfileState(),
    ]);
    const ref = library.lastUsed;
    if (!ref) throw new Error("Select a Profile before loading its workflows.");
    return ensureLocalProfileWorkflows({
      store: deps.store,
      storeDir: deps.storeDir,
      ref,
      profile,
      reloadProfile: loadOpenPondProfileState,
    });
  }

  const profileReports = createProfileEvaluationReportService({
    store: deps.store,
    selectedProfile: async () => {
      const [library, profile] = await Promise.all([loadOpenPondProfileLibrary(), loadOpenPondProfileState()]);
      if (!library.lastUsed || !profile.sourcePath || profile.error) return null;
      return { ref: library.lastUsed, sourcePath: profile.sourcePath, gitBacked: profile.git?.isRepo === true };
    },
  });

  async function profileEvaluationsPayload(params?: unknown) {
    const workflows = await profileWorkflowsPayload();
    if (params && typeof params === "object" && !Array.isArray(params) && "runId" in params) {
      const runId = (params as { runId?: unknown }).runId;
      if (typeof runId !== "string" || !runId.trim() || runId.length > 240 || Object.keys(params).length !== 1) {
        throw new Error("Invalid Profile evaluation run request.");
      }
      return inspectProfileEvaluationRun({ store: deps.store, profileRef: workflows.profileRef, runId });
    }
    const evaluations = await profileEvaluationsForRelease({
      store: deps.store,
      ref: workflows.profileRef,
      sourceRevision: workflows.sourceRevision,
      harnessRelease: workflows.harnessRelease,
    });
    const [runs, comparisons, suiteRuns, reports] = await Promise.all([
      deps.store.listProfileEvaluationRuns(workflows.profileRef),
      deps.store.listProfileEvaluationComparisons(workflows.profileRef),
      deps.store.listProfileEvaluationSuiteRuns(workflows.profileRef),
      profileReports.list(),
    ]);
    return { ...evaluations, runs, comparisons, suiteRuns, reports };
  }

  const prepareProfileEvaluationRun = createProfileEvaluationRunPreparationService({
    store: deps.store,
    selectedWorkflows: profileWorkflowsPayload,
    loadTasksetPackage: (definition, profileId, harnessRelease) => loadLocalProfileEvaluationTaskset({
      store: deps.store, storeDir: deps.storeDir, definition, profileId, harnessRelease,
    }),
    modelConfigurationHash: async (modelRef) => {
      const settings = await deps.providerSettings();
      const status = settings.statuses[modelRef.providerId];
      const provider = settings.providers[modelRef.providerId];
      if (!status?.enabled || !status.available || !status.credential.connected) {
        throw new Error(`Model provider ${modelRef.providerId} is unavailable for evaluation.`);
      }
      const availableModels = new Set([
        ...status.modelIds,
        ...(settings.modelCaches[modelRef.providerId]?.models.map((model) => model.id) ?? []),
        ...(provider?.modelOverrides ?? []),
        status.defaultModel,
        provider?.defaultModel,
      ]);
      if (!availableModels.has(modelRef.modelId)) {
        throw new Error(`Model ${modelRef.providerId}/${modelRef.modelId} is unavailable for evaluation.`);
      }
      return contentHash({
        modelRef,
        provider: provider ?? null,
        credential: status.credential.source,
      });
    },
    placement: "local",
  });

  const profileEvaluationPreparePayload = async (request: unknown) => {
    const prepared = await prepareProfileEvaluationRun(request);
    return {
      manifest: prepared.manifest,
      taskset: {
        id: prepared.taskset.id,
        contentHash: prepared.taskset.contentHash,
        connectedAppScopes: prepared.taskset.policy.connectedAppScopes,
      },
    };
  };

  const profileEvaluationComparePayload = createProfileEvaluationComparisonService({
    store: deps.store,
    selectedProfile: async () => {
      const workflows = await profileWorkflowsPayload();
      return { ref: workflows.profileRef, sourceRevision: workflows.sourceRevision };
    },
  });
  const profileEvaluationSaveReportPayload = profileReports.save;

  async function profileSelectPayload(payload: unknown) {
    const input = asRecord(payload);
    const ref = OpenPondProfileRefSchema.parse(input.ref ?? input);
    const profile = await selectOpenPondProfile(ref);
    return {
      profile: profileStateForClient(profile),
      library: profileLibraryForClient(await loadOpenPondProfileLibrary()),
    };
  }

  async function profileRemovePayload(payload: unknown) {
    const input = asRecord(payload);
    const ref = OpenPondProfileRefSchema.parse(input.ref ?? input);
    return profileLibraryForClient(await removeOpenPondProfile(ref));
  }

  async function profilePublicationPreviewPayload(payload: unknown) {
    return previewOpenPondProfilePublication(payload);
  }

  async function profilePublicationPublishPayload(payload: unknown) {
    const result = await publishOpenPondProfile(payload);
    await appendRuntimeEvent(event({
      name: "diagnostic",
      source: "server",
      action: "openpond.profile.publish",
      status: "completed",
      output: `Published Profile to ${result.owner}/${result.repository}.`,
      data: result,
    }));
    return result;
  }

  async function profileInstallPayload(payload: unknown) {
    const input = asRecord(payload);
    const source = input.source === "openpond_git" ? "openpond_git" : input.source === "github" ? "github" : null;
    const repositoryId = stringValue(input.repositoryId);
    if (!source || !repositoryId) throw new Error("Profile source and owner/repository are required.");
    const state = await installOpenPondProfile({
      source,
      repositoryId,
      url: stringValue(input.url),
      profile: stringValue(input.profile),
    });
    return {
      profile: profileStateForClient(state),
      library: profileLibraryForClient(await loadOpenPondProfileLibrary()),
    };
  }

  async function profileUpdatePayload(payload: unknown) {
    const input = asRecord(payload);
    const ref = OpenPondProfileRefSchema.parse(input.ref ?? input);
    const state = await updateInstalledOpenPondProfile(ref);
    return {
      profile: profileStateForClient(state),
      library: profileLibraryForClient(await loadOpenPondProfileLibrary()),
    };
  }

  async function profileInitPayload(payload: unknown) {
    const input = asRecord(payload);
    const state = await initLocalProfileRepo({
      repoPath:
        stringValue(input.path) ?? stringValue(input.repoPath) ?? undefined,
      profile: stringValue(input.profile) ?? undefined,
      template: stringValue(input.template) ?? undefined,
      force: booleanValue(input.force) ?? false,
    });
    await appendRuntimeEvent(
      event({
        name: "diagnostic",
        source: "server",
        action: "openpond.profile.init",
        status: "completed",
        output: `Initialized OpenPond profile ${
          state.activeProfile ?? "default"
        }.`,
      })
    );
    return profileStateForClient(state);
  }

  async function profileLoadPayload(payload: unknown) {
    const input = asRecord(payload);
    const repoPath = stringValue(input.path) ?? stringValue(input.repoPath);
    if (!repoPath) throw new Error("Profile repo path is required.");
    const state = await loadLocalProfileRepo(
      repoPath,
      stringValue(input.profile) ?? undefined
    );
    await appendRuntimeEvent(
      event({
        name: "diagnostic",
        source: "server",
        action: "openpond.profile.load",
        status: "completed",
        output: `Loaded OpenPond profile ${state.activeProfile ?? "default"}.`,
      })
    );
    return profileStateForClient(state);
  }

  async function profileCheckPayload(payload: unknown) {
    const input = asRecord(payload);
    const kind = stringValue(input.kind) ?? "all";
    await runProfileCheck(kind);
    const state = await loadOpenPondProfileState();
    await appendRuntimeEvent(
      event({
        name: "diagnostic",
        source: "server",
        action: "openpond.profile.check",
        status: "completed",
        output: `Profile check completed for ${kind}.`,
      })
    );
    return profileStateForClient(state);
  }

  async function profileRenameAgentPayload(agentId: string, payload: unknown) {
    const input = asRecord(payload);
    const name = stringValue(input.name);
    if (!name) throw new Error("Agent name is required.");
    const state = await renameActiveProfileAgent(agentId, name);
    await appendRuntimeEvent(
      event({
        name: "diagnostic",
        source: "server",
        action: "openpond.profile.agent.rename",
        status: "completed",
        output: `Renamed Profile agent ${agentId} to ${name.trim()}.`,
      })
    );
    return profileStateForClient(state);
  }

  async function profileCommitPayload(payload: unknown) {
    const input = asRecord(payload);
    const result = await commitActiveProfileChanges(
      stringValue(input.message) ??
        stringValue(input.commitMessage) ??
        undefined
    );
    await appendRuntimeEvent(
      event({
        name: "diagnostic",
        source: "server",
        action: "openpond.profile.commit",
        status: "completed",
        output: result.committed
          ? "Committed OpenPond profile changes."
          : "No OpenPond profile changes to commit.",
      })
    );
    return result;
  }

  async function profilePushPayload(payload: unknown) {
    const input = asRecord(payload);
    const teamId = stringValue(input.teamId);
    if (!teamId) throw new Error("teamId is required.");
    const profile = await loadOpenPondProfileState();
    if (profile.error) throw new Error(profile.error);
    if (!profile.repoPath || !profile.sourcePath || !profile.manifestPath) {
      throw new Error("No active OpenPond profile. Run `openpond init`.");
    }
    if (!profile.git?.isRepo) {
      throw new Error("Active OpenPond profile source is not Git-backed.");
    }
    if (!profile.git.head) {
      throw new Error(
        "Profile source must have a committed Git head before push."
      );
    }
    if (profile.git.dirty) {
      throw new Error(
        "Profile source has uncommitted changes. Commit before pushing."
      );
    }

    const hostedPayload = asRecord(
      await sandboxRequestPayload({
        type: booleanValue(input.ensureHosted)
          ? "profile_ensure"
          : "profile_get",
        payload: { teamId },
      })
    );
    const hostedProfile = asRecord(hostedPayload.profile);
    if (!hostedProfile) {
      throw new Error(
        "No hosted OpenPond profile repo found. Run `openpond profile ensure-hosted` first."
      );
    }
    const sourceUpload = asRecord(hostedProfile.sourceUpload);
    const currentHostedHead =
      stringValue(sourceUpload?.sourceCommitSha) ?? null;
    const lastPushedHostedHead = profile.hosted?.sourceCommitSha ?? null;
    if (
      lastPushedHostedHead &&
      currentHostedHead !== lastPushedHostedHead &&
      !booleanValue(input.force)
    ) {
      throw new Error(
        "Hosted profile source changed since the last local push. Inspect hosted changes or push with force."
      );
    }

    const manifest = JSON.parse(
      await readFile(profile.manifestPath, "utf8")
    ) as ProfileRepoManifest;
    const sourcePath =
      manifest.profiles[profile.activeProfile ?? manifest.defaultProfile]
        ?.path ?? "profiles/default";
    const upload = await collectProfileSourceUploadEntries(profile.repoPath);
    const pushPayload = asRecord(
      await sandboxRequestPayload({
        type: "profile_push",
        payload: {
          teamId,
          entries: upload.entries,
          branch: profile.git.branch ?? "main",
          commitMessage:
            stringValue(input.commitMessage) ??
            stringValue(input.message) ??
            `Push OpenPond profile ${profile.activeProfile ?? "default"} at ${
              profile.git.shortHead ?? profile.git.head
            }`,
          expectedSourceCommitSha: currentHostedHead,
          localHeadSha: profile.git.head,
          manifest,
          sourcePath,
          agents: profile.agents.map((agent) => ({
            id: agent.id,
            name: agent.name,
            path: agent.path,
            enabled: agent.enabled,
          })),
        },
      })
    );
    const pushedProfile = asRecord(pushPayload.profile);
    const pushedSourceUpload = asRecord(pushPayload.sourceUpload);
    const pushedAt = new Date().toISOString();
    let pushStatus: LocalOpenPondProfilePushStatus = {
      status: "pushed",
      promotionStatus: "uploaded",
      hostedRunStatus: "not_started",
      pushedAt,
      teamId,
      projectId: stringValue(asRecord(pushedProfile?.project)?.id),
      localHead: profile.git.head,
      hostedHead: stringValue(pushedSourceUpload?.sourceCommitSha),
      sourceRef: stringValue(pushedSourceUpload?.sourceRef),
    };
    await saveProfilePushStatus(pushStatus);

    const hostedSourceAgentId =
      stringValue(input.hostedSourceAgentId) ??
      stringValue(input.hostedRunAgentId);
    const requestHostedSourceChecks = Boolean(
      booleanValue(input.hostedSourceChecks)
    );
    const publishHostedSource = Boolean(
      booleanValue(input.publishHostedSource)
    );
    const hostedSourceDispatch =
      parseHostedSourceDispatch(stringValue(input.hostedSourceDispatch)) ??
      "coding_core";
    let hostedRuntimeAgentId = hostedSourceAgentId;
    let hostedSourceDeployPlan: Record<string, unknown> | null = null;
    let hostedSourceChecks: Record<string, unknown> | null = null;
    let hostedSourcePublish: Record<string, unknown> | null = null;

    if (hostedSourceAgentId) {
      const profileProjectId = pushStatus.projectId;
      const sourceRef =
        stringValue(pushedSourceUpload?.sourceRef) ??
        profile.git.branch ??
        "main";
      if (!profileProjectId) {
        throw new Error(
          "Hosted profile push did not return a profile project id.",
        );
      }
      try {
        const hostedSourceMaterialization =
          await materializeHostedProfileAgentSource({
            client: await resolveOpenPondSandboxClient(),
            teamId,
            profileProjectId,
            profileName: profile.activeProfile ?? manifest.defaultProfile,
            state: profile,
            agentId: hostedSourceAgentId,
            sourceRef,
            localHead: profile.git.head,
            hostedHead: stringValue(pushedSourceUpload?.sourceCommitSha),
            projectId:
              profile.hosted?.teamId === teamId &&
              profile.hosted.hostedSourceMaterialization?.agentId ===
                hostedSourceAgentId
                ? profile.hosted.hostedSourceMaterialization.projectId
                : null,
          });
        hostedRuntimeAgentId =
          hostedSourceMaterialization.runtimeAgentId ?? hostedSourceAgentId;
        pushStatus = {
          ...pushStatus,
          promotionStatus: "hosted_source_materialized",
          hostedSourceMaterialization,
        };
        await saveProfilePushStatus(pushStatus);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        pushStatus = {
          ...pushStatus,
          promotionStatus: "hosted_source_materialize_failed",
          hostedSourceMaterialization: {
            status: "failed",
            agentId: hostedSourceAgentId,
            projectId: null,
            error: message,
          },
          error: message,
        };
        await saveProfilePushStatus(pushStatus);
        throw new Error(
          `Hosted source materialization failed after push: ${message}`,
        );
      }
    }

    if (requestHostedSourceChecks || publishHostedSource) {
      if (!hostedSourceAgentId) {
        throw new Error(
          "hostedSourceAgentId or hostedRunAgentId is required for hosted source checks or publish."
        );
      }
      if (!hostedRuntimeAgentId) {
        throw new Error(
          "Unable to resolve the hosted runtime agent for source checks.",
        );
      }
      try {
        const deployPlanPayload = asRecord(
          await sandboxRequestPayload({
            type: "agent_source_deploy_plan",
            agentId: hostedRuntimeAgentId,
            payload: { teamId },
          })
        );
        hostedSourceDeployPlan = asRecord(deployPlanPayload.deployPlan);
        if (requestHostedSourceChecks) {
          hostedSourceChecks = asRecord(
            await sandboxRequestPayload({
              type: "agent_source_checks",
              agentId: hostedRuntimeAgentId,
              payload: {
                teamId,
                sourceRef:
                  pushStatus.hostedSourceMaterialization?.sourceRef ??
                  stringValue(pushedSourceUpload?.sourceRef),
                baseSha:
                  pushStatus.hostedSourceMaterialization?.sourceCommitSha ??
                  stringValue(pushedSourceUpload?.sourceCommitSha),
                checkKind:
                  stringValue(input.hostedCheckKind) ??
                  stringValue(input.checkKind) ??
                  "all",
                dispatch: hostedSourceDispatch,
                metadata: {
                  source: "openpond_profile_push_checks",
                  localHead: profile.git.head,
                  hostedHead: stringValue(pushedSourceUpload?.sourceCommitSha),
                  materializedProjectId:
                    pushStatus.hostedSourceMaterialization?.projectId ?? null,
                  materializedSourceCommitSha:
                    pushStatus.hostedSourceMaterialization?.sourceCommitSha ??
                    null,
                  sourceRef:
                    pushStatus.hostedSourceMaterialization?.sourceRef ??
                    stringValue(pushedSourceUpload?.sourceRef),
                  dispatch: hostedSourceDispatch,
                },
              },
            })
          );
          const dispatchResult = asRecord(hostedSourceChecks.dispatchResult);
          if (stringValue(dispatchResult.status) === "failed") {
            throw new Error(
              stringValue(dispatchResult.error) ??
                "hosted_source_check_dispatch_failed"
            );
          }
        }
        pushStatus = {
          ...pushStatus,
          promotionStatus: requestHostedSourceChecks
            ? "hosted_source_check_pending"
            : pushStatus.promotionStatus,
          hostedSourceCheck: hostedSourceCheckStatusFromPayload({
            agentId: hostedRuntimeAgentId,
            status: requestHostedSourceChecks
              ? "requested"
              : "deploy_plan_ready",
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
        throw new Error(
          "hostedSourceAgentId or hostedRunAgentId is required for hosted source publish."
        );
      }
      if (!hostedRuntimeAgentId) {
        throw new Error(
          "Unable to resolve the hosted runtime agent for source publish.",
        );
      }
      try {
        const deployPlanSource = asRecord(hostedSourceDeployPlan?.source);
        const expectedManifestHash =
          stringValue(input.expectedManifestHash) ??
          pushStatus.hostedSourceCheck?.manifestHash ??
          stringValue(deployPlanSource?.manifestHash);
        hostedSourcePublish = asRecord(
          await sandboxRequestPayload({
            type: "agent_source_publish",
            agentId: hostedRuntimeAgentId,
            payload: {
              teamId,
              expectedManifestHash,
              expectedSourceCommitSha: stringValue(
                pushStatus.hostedSourceMaterialization?.sourceCommitSha ??
                  pushedSourceUpload?.sourceCommitSha
              ),
            },
          })
        );
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

    const hostedRunAgentId = stringValue(input.hostedRunAgentId);
    let hostedRun: Record<string, unknown> | null = null;
    if (hostedRunAgentId) {
      const hostedRunStartedAt = new Date().toISOString();
      const hostedRunInput = nonEmptyRecord(input.hostedRunInput) ?? {
        prompt: "hello",
        channel: "openpond_chat",
      };
      const hostedRunTargetProjectId = stringValue(
        input.hostedRunTargetProjectId
      );
      const hostedRunIdempotencyKey = buildHostedRunIdempotencyKey({
        explicitKey: stringValue(input.hostedRunIdempotencyKey),
        retry: booleanValue(input.hostedRunRetry) ?? false,
        localHead: profile.git.head,
        sourceHead: stringValue(pushedSourceUpload?.sourceCommitSha),
        runtimeAgentId: hostedRunAgentId,
        targetProjectId: hostedRunTargetProjectId,
        input: hostedRunInput,
      });
      await saveProfilePushStatus({
        ...pushStatus,
        promotionStatus: "hosted_run_pending",
        hostedRunStatus: "running",
        hostedRunAgentId,
        hostedRunAt: hostedRunStartedAt,
      });
      try {
        hostedRun = asRecord(
          await sandboxRequestPayload({
            type: "agent_run",
            agentId: hostedRunAgentId,
            payload: {
              teamId,
              ...(hostedRunTargetProjectId
                ? { targetProjectId: hostedRunTargetProjectId }
                : {}),
              ...(hostedRunTargetProjectId
                ? { targetProject: { id: hostedRunTargetProjectId } }
                : {}),
              idempotencyKey: hostedRunIdempotencyKey,
              input: hostedRunInput,
              metadata: {
                source: "openpond_profile_push_run",
                targetProjectId: hostedRunTargetProjectId ?? null,
                localHead: profile.git.head,
                hostedHead: stringValue(pushedSourceUpload?.sourceCommitSha),
                hostedRunIdempotencyKey,
                hostedRunRetry: Boolean(booleanValue(input.hostedRunRetry)),
                sourceRef: stringValue(pushedSourceUpload?.sourceRef),
                publishedSnapshotId:
                  pushStatus.hostedPublish?.snapshotId ?? null,
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
            },
          })
        );
        const run = asRecord(hostedRun.run);
        const hostedRunSummary = hostedRunSummaryFromPayload({
          agentId: hostedRunAgentId,
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
          hostedRunAgentId,
          hostedRunId: stringValue(run.id),
          hostedRunAt: stringValue(run.createdAt) ?? hostedRunStartedAt,
          hostedRun: hostedRunSummary,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await saveProfilePushStatus({
          ...pushStatus,
          promotionStatus: "hosted_run_failed",
          hostedRunStatus: "failed",
          hostedRunAgentId,
          hostedRunAt: new Date().toISOString(),
          hostedRun: {
            status: "failed",
            agentId: hostedRunAgentId,
            error: message,
          },
          error: message,
        });
        throw new Error(
          `Hosted invocation failed to start after push: ${message}`
        );
      }
    }
    await appendRuntimeEvent(
      event({
        name: "diagnostic",
        source: "server",
        action: "openpond.profile.push",
        status: "completed",
        output: `Pushed OpenPond profile ${
          profile.activeProfile ?? "default"
        }.`,
      })
    );
    return {
      ...pushPayload,
      hostedSourceChecks,
      hostedSourcePublish,
      hostedRun,
      uploaded: upload,
      localProfile: await loadOpenPondProfileState(),
    };
  }

  async function profileRunPayload(payload: unknown) {
    const input = asRecord(payload);
    const action = stringValue(input.action) ?? stringValue(input.actionName);
    if (!action) throw new Error("Profile action name is required.");
    const metadata = asRecord(input.metadata);
    const actionInput = asRecord(input.input);
    const sessionId = stringValue(metadata.sessionId);
    const prompt =
      stringValue(actionInput.prompt) ??
      stringValue(actionInput.message) ??
      `Run ${action}`;
    const displayPrompt = stringValue(metadata.displayPrompt) ?? prompt;
    const selectedActionLabel =
      stringValue(metadata.selectedActionLabel) ??
      stringValue(metadata.selectedActionId) ??
      action;
    const args = [action];
    if (input.input !== undefined) {
      args.push("--input", JSON.stringify(input.input));
    }
    const result = await runProfileSdkCommand({
      command: "run",
      args,
    });
    const runSummary = profileActionRunSummary({
      action,
      code: result.code,
      stderr: result.stderr,
      stdout: result.stdout,
    });
    if (sessionId) {
      const turnId = `openpond_profile_action_${Date.now()}`;
      await appendRuntimeEvent(
        event({
          name: "turn.started",
          sessionId,
          turnId,
          source: "chat_action",
          args: { prompt: displayPrompt },
        })
      );
      await appendRuntimeEvent(
        event({
          name: "workspace_action_result",
          sessionId,
          turnId,
          source: "chat_action",
          action: "profile_run_action",
          appId: null,
          status: runSummary.status,
          output: runSummary.output,
          data: {
            openPondProfileActionRun: true,
            action: {
              name: action,
              label: selectedActionLabel,
              implementation: {
                type: "openpond-profile-action",
                actionId: action,
              },
            },
            stdout: result.stdout,
            stderr: result.stderr,
            code: result.code,
            responseSummary: runSummary.responseSummary,
            artifactRefs: runSummary.artifactRefs,
            traceArtifactRefs: runSummary.traceArtifactRefs,
          },
        })
      );
    }
    await appendRuntimeEvent(
      event({
        name: "diagnostic",
        source: "server",
        action: "openpond.profile.run",
        status: "completed",
        output: `Ran profile action ${action}.`,
      })
    );
    return {
      action,
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code,
    };
  }

  return {
    profileCurrentPayload,
    profileCatalogPayload,
    profileWorkflowsPayload,
    profileEvaluationsPayload,
    profileEvaluationPreparePayload,
    prepareProfileEvaluationRun,
    profileEvaluationComparePayload,
    profileEvaluationSaveReportPayload,
    profileSelectPayload,
    profileRemovePayload,
    profilePublicationPreviewPayload,
    profilePublicationPublishPayload,
    profileInstallPayload,
    profileUpdatePayload,
    profileInitPayload,
    profileLoadPayload,
    profileCheckPayload,
    profileRenameAgentPayload,
    profileCommitPayload,
    profilePushPayload,
    profileRunPayload,
  };
}
