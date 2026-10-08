import {createHostedProfileVerifier} from "../evaluations/profile-sandbox-verifier.js";
import { createHostProfileExternalDataset, type HostProfileExternalDataset } from "../harness/host-profile-external-dataset.js";
import type { AgentHostStorageClient } from "@openpond/agent-runtime";
import {
  CreateSessionRequestSchema,
  SendTurnRequestSchema,
  type Session,
  type Turn,
} from "@openpond/contracts";
import type { AppServerRuntimeCoreStorage } from "../app-server-runtime.js";
import type { AdmittedHostedProfileRelease } from "../store/hosted-profile-source.js";
import { listHostedProfileWorkflows } from "../store/hosted-profile-source.js";
import { loadHostedHarnessRuntime } from "../store/hosted-harness-runtime.js";
import { HostedProfileEvaluationStorage } from "../store/hosted-profile-evaluation-storage.js";
import {
  profileEvaluationsForRuntime,
  type ProfileEvaluationCatalogSource,
} from "../harness/local-profile-evaluation-runtime.js";
import { loadReleasedProfileEvaluationTaskset } from "../harness/local-profile-evaluation-taskset.js";
import { createProfileEvaluationRunPreparationService } from "../harness/profile-evaluation-run-preparation.js";
import { createProfileEvaluationCaseService } from "../harness/profile-evaluation-case-service.js";
import { createProfileEvaluationRunService } from "../harness/profile-evaluation-run-service.js";
import { createProfileEvaluationSuiteService } from "../harness/profile-evaluation-suite-service.js";
import { createProfileEvaluationComparisonService } from "../harness/profile-evaluation-comparison-service.js";
import { buildProfileEvaluationReport } from "../harness/profile-evaluation-report-service.js";
import {
  inspectProfileEvaluationRun,
  ProfileEvaluationInspectionRequestSchema,
} from "../harness/profile-evaluation-run-inspection.js";
import { contentHash } from "@openpond/harness";
import {
  createProfilePrivateGradingOwner,
  preflightProfilePrivateGrading,
} from "../harness/profile-private-grading.js";

/** Use the same evaluator and immutable assets as Desktop, with host-owned stores. */
export async function createHostedProfileEvaluationRuntime(input: {
  client: AgentHostStorageClient;
  core: AppServerRuntimeCoreStorage;
  release: AdmittedHostedProfileRelease;
  externalDataset?: HostProfileExternalDataset;
  storeDir: string;
  readManagedArtifact: Parameters<
    typeof createProfileEvaluationCaseService
  >[0]["readManagedArtifact"];
  admitSession: NonNullable<
    Parameters<typeof createProfileEvaluationCaseService>[0]["admitSession"]
  >;
  settleSession: NonNullable<
    Parameters<typeof createProfileEvaluationCaseService>[0]["settleSession"]
  >;
  createSession: (request: unknown) => Promise<Session>;
  sendTurn: (sessionId: string, request: unknown) => Promise<Turn>;
  interruptSessionTurn: (sessionId: string, reason?: string) => Promise<Turn>;
}) {
  const release = input.release;
  if (!release.hostExecution)
    throw new Error(
      "Hosted evaluation requires explicit host execution attribution.",
    );
  const metadata = {
    hostConversationId: release.hostExecution.conversationId,
    hostTurnId: release.hostExecution.turnId,
  };
  const ref = {
    source: "openpond_git" as const,
    profileId: release.profileId,
    repositoryId: release.repositoryId,
  };
  const selectedProfile = async () => ({
    ref,
    sourceRevision: release.sourceRevision,
  });
  const selectedWorkflows = () =>
    listHostedProfileWorkflows(input.client, release);
  const records = new HostedProfileEvaluationStorage(input.client);
  const loadRuntime = async (reference: {
    id: string;
    contentHash: string;
  }) => {
    if (contentHash(reference) !== contentHash(release.harnessRelease))
      throw new Error("Evaluation requires the admitted Profile release.");
    const runtime = await loadHostedHarnessRuntime(input.client, reference);
    if (!runtime)
      throw new Error("Admitted evaluation Profile is unavailable.");
    return runtime;
  };
  const loadCatalog: ProfileEvaluationCatalogSource = async (request) => {
    if (
      contentHash(request.ref) !== contentHash(ref) ||
      request.sourceRevision !== release.sourceRevision
    ) {
      throw new Error("Evaluation requires the admitted Profile source.");
    }
    return profileEvaluationsForRuntime({
      ...request,
      runtime: await loadRuntime(request.harnessRelease),
    });
  };
  const externalDataset = input.externalDataset
    ? await createHostProfileExternalDataset({
        value: input.externalDataset,
        release: (await loadRuntime(release.harnessRelease)).release,
        sourceRevision: release.sourceRevision,
        client: input.client,
      })
    : null;
  const loadTasksetPackage: Parameters<
    typeof createProfileEvaluationCaseService
  >[0]["loadTasksetPackage"] = async (
    definition,
    profileId,
    harnessRelease,
  ) => {
    if (profileId !== release.profileId)
      throw new Error(
        "Evaluation Taskset Profile differs from its admitted source.",
      );
    const packageValue = await loadReleasedProfileEvaluationTaskset({
      definition,
      harnessRelease,
      runtime: await loadRuntime(harnessRelease),
    });
    if (!packageValue)
      throw new Error(
        "Evaluation Taskset is absent from the admitted Profile release.",
      );
    return packageValue;
  };
  const executeProfileEvaluationCase = createProfileEvaluationCaseService({
    resolveExternalDataset: externalDataset?.resolveExternalDataset,
    store: {
      runtimeEventsForTurn: (turnId) => input.core.runtimeEventsForTurn(turnId),
    },
    storeDir: input.storeDir,
    readManagedArtifact: input.readManagedArtifact,
    admitSession: input.admitSession,
    settleSession: input.settleSession,
    loadCatalog,
    loadTasksetPackage,
    selectedProfile,
    createSession: (request) => {
      const parsed = CreateSessionRequestSchema.parse(request);
      return input.createSession({
        ...parsed,
        metadata: { ...parsed.metadata, ...metadata },
      });
    },
    sendTurn: (sessionId, request) => {
      const parsed = SendTurnRequestSchema.parse(request);
      return input.sendTurn(sessionId, {
        ...parsed,
        metadata: { ...parsed.metadata, ...metadata },
      });
    },
    interruptSessionTurn: input.interruptSessionTurn,
  });
  const prepareProfileEvaluationRun =
    createProfileEvaluationRunPreparationService({
      resolveExternalDataset: externalDataset?.resolveExternalDataset,
      sourceCandidate: externalDataset?.sourceCandidate,
      privateGradingPreflight: (value) =>
        preflightProfilePrivateGrading(value, false),
      loadCatalog,
      selectedWorkflows,
      loadTasksetPackage,
      placement: "remote",
      boundedWorkComputeAvailable: true,
      modelConfigurationHash: async (modelRef, request) => {
        if (
          modelRef.providerId !== "openpond" ||
          !request.hostModelConfigurationHash
        ) {
          throw new Error(
            "Hosted evaluation requires a host-admitted model configuration receipt.",
          );
        }
        return request.hostModelConfigurationHash;
      },
    });
  const executeProfileEvaluationRun = createProfileEvaluationRunService({
    resolveExternalDataset: externalDataset?.resolveExternalDataset,
    store: records,
    loadCatalog,
    loadTasksetPackage,
    selectedProfile,
    executeCase: executeProfileEvaluationCase,
    privateGrading: (manifest, packageValue, signal) =>
      createProfilePrivateGradingOwner({
        manifest,
        packageValue,
        signal,
        executeSandboxVerifier: createHostedProfileVerifier(input.client),
        authorize: async () => {
          const source = manifest.profileEvaluation;
          if (
            !source ||
            source.profileId !== release.profileId ||
            source.sourceRevision !== release.sourceRevision
          )
            throw new Error("The hosted private grading source changed.");
          if (source.externalDatasetBinding) {
            if (!externalDataset) throw new Error("The frozen Dataset owner is unavailable.");
            await externalDataset.authorize({
              bindingHash: source.externalDatasetBinding.contentHash,
              manifestHash: manifest.contentHash,
            });
          }
          const catalog = await loadCatalog({
            ref,
            sourceRevision: release.sourceRevision,
            harnessRelease: source.harnessRelease,
          });
          if (!source.externalDatasetBinding && catalog.catalogHash !== source.catalogHash)
            throw new Error("The hosted private grading catalog changed.");
        },
      }),
  });
  const inspectionStore = {
    getProfileEvaluationRun: records.getProfileEvaluationRun.bind(records),
    getProfileEvaluationReceipt:
      records.getProfileEvaluationReceipt.bind(records),
    getProfileEvaluationGrade: records.getProfileEvaluationGrade.bind(records),
    getSession: input.core.getSession.bind(input.core),
    getTurn: input.core.getTurn.bind(input.core),
    runtimeEventsForTurn: input.core.runtimeEventsForTurn.bind(input.core),
    listModelUsageRecords: input.core.listModelUsageRecords.bind(input.core),
  };
  return {
    prepareProfileEvaluationRun,
    executeProfileEvaluationCase,
    executeProfileEvaluationRun,
    runPreparedProfileEvaluation: async (request: unknown) =>
      executeProfileEvaluationRun(
        await prepareProfileEvaluationRun(request, {
          requireExpectedManifestHash: true,
        }),
      ),
    runProfileEvaluationSuite: createProfileEvaluationSuiteService({
      store: records,
      loadCatalog,
      selectedWorkflows,
      prepareRun: prepareProfileEvaluationRun,
      executeRun: executeProfileEvaluationRun,
    }),
    compareProfileEvaluationRuns: createProfileEvaluationComparisonService({
      store: records,
      selectedProfile,
    }),
    buildProfileEvaluationReport: (request: unknown) =>
      buildProfileEvaluationReport({
        store: records,
        profileRef: ref,
        request,
      }),
    listProfileEvaluations: async (params?: unknown) => {
      if (params && typeof params === "object" && "runId" in params) {
        return inspectProfileEvaluationRun({
          store: inspectionStore,
          profileRef: ref,
          ...ProfileEvaluationInspectionRequestSchema.parse(params),
        });
      }
      const [catalog, runs, comparisons, suiteRuns] = await Promise.all([
        loadCatalog({
          ref,
          sourceRevision: release.sourceRevision,
          harnessRelease: release.harnessRelease,
        }),
        records.listProfileEvaluationRuns(ref),
        records.listProfileEvaluationComparisons(ref),
        records.listProfileEvaluationSuiteRuns(ref),
      ]);
      return { ...catalog, runs, comparisons, suiteRuns };
    },
  };
}
