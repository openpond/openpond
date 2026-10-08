import {
  loadOpenPondProfileLibrary,
  loadOpenPondProfileState
} from "@openpond/cloud";
import type { OpenPondProfileRef } from "@openpond/contracts";
import {
  streamOpenPondHostedChatTurn as defaultStreamOpenPondHostedChatTurn
} from "@openpond/runtime";
import { z } from "zod";
import type { OpenPondAppServerOptions } from "../app-server-runtime.js";
import { createExperimentCaseService } from "../evaluations/experiment-case-service.js";
import { createHostExperimentEnvironment } from "../evaluations/host-experiment-environment.js";
import { createHostExperimentNativeStream } from "../evaluations/host-experiment-native-stream.js";
import { createHostExperimentPolicy } from "../evaluations/host-experiment-policy.js";
import { createLocalExperimentPolicy } from "../evaluations/local-experiment-policy.js";
import { createHostProfileEvaluationTools } from "../harness/host-profile-evaluation-tools.js";
import { createHostProfileExternalDataset } from "../harness/host-profile-external-dataset.js";
import { profileEvaluationsForRelease } from "../harness/local-profile-evaluation-runtime.js";
import { loadLocalProfileEvaluationTaskset } from "../harness/local-profile-evaluation-taskset.js";
import { ensureLocalProfileWorkflows } from "../harness/local-profile-workflow-runtime.js";
import { createProfileEvaluationCaseService } from "../harness/profile-evaluation-case-service.js";
import { createProfileEvaluationComparisonService } from "../harness/profile-evaluation-comparison-service.js";
import { buildProfileEvaluationReport } from "../harness/profile-evaluation-report-service.js";
import { inspectProfileEvaluationRun, ProfileEvaluationInspectionRequestSchema } from "../harness/profile-evaluation-run-inspection.js";
import { createProfileEvaluationRunPreparationService } from "../harness/profile-evaluation-run-preparation.js";
import { createProfileEvaluationRunService } from "../harness/profile-evaluation-run-service.js";
import { createProfileEvaluationSuiteService } from "../harness/profile-evaluation-suite-service.js";
import { createProfilePrivateGradingOwner, preflightProfilePrivateGrading } from "../harness/profile-private-grading.js";
import { installPublishedExperimentSource } from "../harness/published-experiment-source.js";
import { standaloneExperimentToolDeclarations } from "../harness/standalone-experiment-tools.js";
import { createStandaloneExperimentTurnOwner } from "../harness/standalone-experiment-turn-owner.js";
import { createAgentRuntimePorts } from "../runtime/agent-runtime-host.js";
import { createSessionStore } from "../store/session-store.js";
import type { LocalHarnessReleaseRecord } from "../store/store-harness-workspaces.js";
import { SqliteStore } from "../store/store.js";
import type { TurnRunner } from "./turns/ports.js";

export function createAppServerEvaluations(input: {
  options: OpenPondAppServerOptions;
  store: SqliteStore;
  storeDir: string;
  explicitProfileRelease: LocalHarnessReleaseRecord | null;
  externalDataset: Awaited<ReturnType<typeof createHostProfileExternalDataset>> | null;
  isolatedProfileTools: ReturnType<typeof createHostProfileEvaluationTools> | null;
  selectedEvaluationProfile: () => Promise<{ ref: OpenPondProfileRef; sourceRevision: string; } | null>;
  listProfileWorkflows: () => ReturnType<typeof ensureLocalProfileWorkflows>;
  createSessionWithAutoTitle: ReturnType<typeof createSessionStore>["createSession"];
  turnRunner: TurnRunner;
  streamOpenPondHostedChatTurn: typeof defaultStreamOpenPondHostedChatTurn;
  publishedExperimentSource: Awaited<ReturnType<typeof installPublishedExperimentSource>> | undefined;
  standaloneExperimentOwner: ReturnType<typeof createStandaloneExperimentTurnOwner> | undefined;
}) {
  const { options, store, storeDir, explicitProfileRelease, externalDataset, isolatedProfileTools,
    selectedEvaluationProfile, listProfileWorkflows, createSessionWithAutoTitle, turnRunner,
    streamOpenPondHostedChatTurn, publishedExperimentSource, standaloneExperimentOwner } = input;
  const shutdown = new AbortController();
  const executeCase = createProfileEvaluationCaseService({
    resolveExternalDataset: externalDataset?.resolveExternalDataset,
    admitSession: isolatedProfileTools?.admitSession, settleSession: isolatedProfileTools?.settleSession,
    loadCatalog: request => profileEvaluationsForRelease({ ...request, store: store }),
    loadTasksetPackage: (definition, profileId, harnessRelease) => loadLocalProfileEvaluationTaskset({ store: store, storeDir: storeDir, definition, profileId, harnessRelease }),
    store,
    storeDir,
    selectedProfile: selectedEvaluationProfile,
    createSession: createSessionWithAutoTitle,
    sendTurn: turnRunner.sendTurn,
    interruptSessionTurn: turnRunner.interruptSessionTurn,
  });
  const executeProfileEvaluationCase = (request: unknown, signal?: AbortSignal) => executeCase(request, signal ? AbortSignal.any([signal, shutdown.signal]) : shutdown.signal);
  const prepareProfileEvaluationRun = createProfileEvaluationRunPreparationService({
    privateGradingPreflight: value => preflightProfilePrivateGrading(value, false),
    resolveExternalDataset: externalDataset?.resolveExternalDataset, sourceCandidate: externalDataset?.sourceCandidate,
    loadCatalog: request => profileEvaluationsForRelease({ ...request, store: store }),
    selectedWorkflows: listProfileWorkflows,
    loadTasksetPackage: (definition, profileId, harnessRelease) => loadLocalProfileEvaluationTaskset({
      store, storeDir, definition, profileId, harnessRelease,
    }),
    modelConfigurationHash: async (modelRef, request) => {
      if (!options.profileSource || modelRef.providerId !== "openpond" || !request.hostModelConfigurationHash) {
        throw new Error("Hosted Profile evaluation requires an explicit source and trusted OpenPond model configuration receipt.");
      }
      return request.hostModelConfigurationHash;
    },
    placement: "remote",
  });
  const executeRun = createProfileEvaluationRunService({
    loadTasksetPackage: (definition, profileId, harnessRelease) => loadLocalProfileEvaluationTaskset({ store, storeDir, definition, profileId, harnessRelease }),
    privateGrading: async (manifest, packageValue, signal) => createProfilePrivateGradingOwner({ manifest, packageValue, signal, authorize: async () => { const selected = await selectedEvaluationProfile(), source = manifest.profileEvaluation; if (!selected || !source || selected.ref.profileId !== source.profileId || selected.sourceRevision !== source.sourceRevision) throw new Error("The current private Profile source changed."); if (externalDataset) await externalDataset.authorize({ bindingHash: source.externalDatasetBinding!.contentHash, manifestHash: manifest.contentHash }); const discovered = await profileEvaluationsForRelease({ ref: selected.ref, sourceRevision: selected.sourceRevision, harnessRelease: source.harnessRelease, store }); if (!source.externalDatasetBinding && discovered.catalogHash !== source.catalogHash) throw new Error("The current private evaluation catalog changed."); } }),
    resolveExternalDataset: externalDataset?.resolveExternalDataset,
    loadCatalog: request => profileEvaluationsForRelease({ ...request, store: store }),
    store, selectedProfile: selectedEvaluationProfile, executeCase: executeProfileEvaluationCase,
  });
  const executeProfileEvaluationRun = (request: unknown, signal?: AbortSignal) => executeRun(request, signal ? AbortSignal.any([signal, shutdown.signal]) : shutdown.signal);
  const executeProfileEvaluationSuite = createProfileEvaluationSuiteService({
    loadCatalog: request => profileEvaluationsForRelease({ ...request, store: store }),
    store, selectedWorkflows: listProfileWorkflows,
    prepareRun: prepareProfileEvaluationRun, executeRun: executeProfileEvaluationRun,
  });
  const experimentCases = createExperimentCaseService({
    ...(publishedExperimentSource && options.experimentPolicyClient ? {
      executeHarness: async (request: import("../evaluations/experiment-case-contract.js").ExperimentModelCase, signal: AbortSignal) => {
        if (!request.harness || !standaloneExperimentOwner) throw new Error("Standalone Experiment source owner is unavailable.");
        const result = await standaloneExperimentOwner.execute({
          executionId: request.id, request, source: request.harness,
          stream: createHostExperimentNativeStream(options.experimentPolicyClient!, request,
            standaloneExperimentToolDeclarations(publishedExperimentSource!.release)), signal, maxOutputBytes: 262_144
        });
        return result.attempt;
      },
    } : {}),
    ...(options.experimentPolicyClient ? {
      resolveEnvironment: async (request: import("../evaluations/experiment-case-contract.js").ExperimentModelCase) =>
        createHostExperimentEnvironment(options.experimentPolicyClient!, request),
    } : {}),
    resolvePolicy: async request => options.experimentPolicyClient
      ? createHostExperimentPolicy(options.experimentPolicyClient, request)
      : createLocalExperimentPolicy({ request, stream: streamOpenPondHostedChatTurn }),
    executeProfile: request => {
      if (options.experimentPolicyClient) throw new Error("A model-case owner cannot execute a Profile.");
      return executeProfileEvaluationCase(request);
    },
  });
  return {
    listProfileEvaluations: async (params?: unknown) => {
      if (params && typeof params === "object" && !Array.isArray(params) && "runId" in params) {
        const inspection = ProfileEvaluationInspectionRequestSchema.parse(params);
        const selected = await selectedEvaluationProfile();
        if (!selected) throw new Error("Select a Profile before inspecting an evaluation run.");
        return inspectProfileEvaluationRun({ store, profileRef: selected.ref, ...inspection });
      }
      if (options.profileSource && explicitProfileRelease) {
        const evaluations = await profileEvaluationsForRelease({
          store,
          ref: { source: "openpond_git", repositoryId: options.profileSource.repositoryId, profileId: options.profileSource.profileId },
          sourceRevision: options.profileSource.sourceRevision,
          harnessRelease: { id: explicitProfileRelease.harnessRelease.id, contentHash: explicitProfileRelease.harnessRelease.contentHash },
        });
        const [runs, comparisons, suiteRuns] = await Promise.all([
          store.listProfileEvaluationRuns({ source: "openpond_git", repositoryId: options.profileSource.repositoryId, profileId: options.profileSource.profileId }),
          store.listProfileEvaluationComparisons({ source: "openpond_git", repositoryId: options.profileSource.repositoryId, profileId: options.profileSource.profileId }),
          store.listProfileEvaluationSuiteRuns({ source: "openpond_git", repositoryId: options.profileSource.repositoryId, profileId: options.profileSource.profileId }),
        ]);
        return { ...evaluations, runs, comparisons, suiteRuns };
      }
      const [library, profile] = await Promise.all([loadOpenPondProfileLibrary(), loadOpenPondProfileState()]);
      if (!library.lastUsed) throw new Error("Select a Profile before loading its evaluations.");
      const workflows = await ensureLocalProfileWorkflows({ store, storeDir, ref: library.lastUsed, profile, reloadProfile: loadOpenPondProfileState });
      const evaluations = await profileEvaluationsForRelease({
        store,
        ref: workflows.profileRef,
        sourceRevision: workflows.sourceRevision,
        harnessRelease: workflows.harnessRelease,
      });
      const [runs, comparisons, suiteRuns] = await Promise.all([
        store.listProfileEvaluationRuns(workflows.profileRef),
        store.listProfileEvaluationComparisons(workflows.profileRef),
        store.listProfileEvaluationSuiteRuns(workflows.profileRef),
      ]);
      return { ...evaluations, runs, comparisons, suiteRuns };
    },
    executeProfileEvaluationCase,
    executeExperimentCase: experimentCases.execute,
    cancelExperimentCase: raw => Promise.resolve(experimentCases.cancel(z.object({ id: z.string().min(1) }).strict().parse(raw).id)),
    executeProfileEvaluationRun,
    prepareProfileEvaluationRun,
    runPreparedProfileEvaluation: async (request) => executeProfileEvaluationRun(await prepareProfileEvaluationRun(request, { requireExpectedManifestHash: true })),
    runProfileEvaluationSuite: executeProfileEvaluationSuite,
    compareProfileEvaluationRuns: createProfileEvaluationComparisonService({ store, selectedProfile: selectedEvaluationProfile }),
    buildProfileEvaluationReport: async (request) => {
      const selected = await selectedEvaluationProfile();
      if (!selected) throw new Error("Select a Profile before building an evaluation report.");
      return buildProfileEvaluationReport({ store, profileRef: selected.ref, request });
    },
    async close() { shutdown.abort(new Error("Evaluation runtime closed")); await experimentCases.close(); },
  } satisfies Pick<Parameters<typeof createAgentRuntimePorts>[0], "listProfileEvaluations" | "executeProfileEvaluationCase" | "executeExperimentCase" | "cancelExperimentCase" | "executeProfileEvaluationRun" | "prepareProfileEvaluationRun" | "runPreparedProfileEvaluation" | "runProfileEvaluationSuite" | "compareProfileEvaluationRuns" | "buildProfileEvaluationReport"> & { close(): Promise<void>; };
}
