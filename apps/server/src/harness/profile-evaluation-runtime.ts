import type { SqliteStore } from "../store/store.js";
import { profileEvaluationsForRelease } from "./local-profile-evaluation-runtime.js";
import { loadLocalProfileEvaluationTaskset } from "./local-profile-evaluation-taskset.js";
import { createProfileEvaluationCaseService } from "./profile-evaluation-case-service.js";
import { createProfileEvaluationRunService } from "./profile-evaluation-run-service.js";
import { createProfileEvaluationSuiteService } from "./profile-evaluation-suite-service.js";
import type { createProfileEvaluationRunPreparationService } from "./profile-evaluation-run-preparation.js";

type CaseDependencies = Parameters<typeof createProfileEvaluationCaseService>[0];
type SuiteDependencies = Parameters<typeof createProfileEvaluationSuiteService>[0];

/** Share the selected-Profile authority across case, run and suite entrypoints. */
export function createProfileEvaluationRuntime(input: {
  store: SqliteStore;
  storeDir: string;
  workflows: SuiteDependencies["selectedWorkflows"];
  prepare: ReturnType<typeof createProfileEvaluationRunPreparationService>;
  createSession: CaseDependencies["createSession"];
  sendTurn: CaseDependencies["sendTurn"];
  interruptSessionTurn: CaseDependencies["interruptSessionTurn"];
}) {
  const selectedEvaluationProfile = async () => {
    const workflows = await input.workflows();
    return { ref: workflows.profileRef, sourceRevision: workflows.sourceRevision };
  };
  const loadCatalog: CaseDependencies["loadCatalog"] = request =>
    profileEvaluationsForRelease({ ...request, store: input.store });
  const executeProfileEvaluationCase = createProfileEvaluationCaseService({
    ...input, loadCatalog, selectedProfile: selectedEvaluationProfile,
    loadTasksetPackage: (definition, profileId, harnessRelease) =>
      loadLocalProfileEvaluationTaskset({ store: input.store, storeDir: input.storeDir, definition, profileId, harnessRelease }),
  });
  const executeProfileEvaluationRun = createProfileEvaluationRunService({
    store: input.store, loadCatalog, selectedProfile: selectedEvaluationProfile, executeCase: executeProfileEvaluationCase,
  });
  const profileEvaluationRunPayload = async (request: unknown) =>
    executeProfileEvaluationRun(await input.prepare(request, { requireExpectedManifestHash: true }));
  const profileEvaluationRunSuitePayload = createProfileEvaluationSuiteService({
    store: input.store, loadCatalog, selectedWorkflows: input.workflows,
    prepareRun: input.prepare, executeRun: executeProfileEvaluationRun,
  });
  return { selectedEvaluationProfile, executeProfileEvaluationCase, executeProfileEvaluationRun,
    profileEvaluationRunPayload, profileEvaluationRunSuitePayload };
}
