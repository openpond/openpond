import type { SqliteStoreCore } from "./store-core.js";

type Migration = {
  version: number;
  run: (store: SqliteStoreCore) => Promise<void>;
};

export const SQLITE_MIGRATIONS: Migration[] = [
  { version: 1, run: (store) => store.createSchema() },
  { version: 2, run: (store) => store.createHotQueryIndexes() },
  { version: 3, run: (store) => store.createReadModelTables() },
  { version: 4, run: async () => undefined },
  { version: 5, run: async () => undefined },
  { version: 6, run: async () => undefined },
  { version: 7, run: (store) => store.createModelUsageTables() },
  { version: 8, run: (store) => store.createLocalAgentScheduleTables() },
  { version: 9, run: (store) => store.createSubagentTables() },
  { version: 10, run: async () => undefined },
  { version: 11, run: (store) => store.createTrainingTables() },
  { version: 12, run: (store) => store.createTaskCreationProjectionTables() },
  { version: 13, run: (store) => store.createGraderAuditTables() },
  { version: 14, run: (store) => store.createTaskAttemptArtifactTables() },
  { version: 15, run: (store) => store.createTrainingChatSearchTables() },
  { version: 16, run: (store) => store.resetTrainingChatSearchForProgressiveIndexing() },
  { version: 17, run: (store) => store.createTaskMinerRunTables() },
  { version: 19, run: (store) => store.createCreateImproveRunTables() },
  { version: 20, run: (store) => store.createTrainingReceiptAndModelBindingTables() },
  { version: 21, run: (store) => store.createTasksetRevisionTables() },
  { version: 24, run: (store) => store.resetLegacySubagentTransportState() },
  { version: 25, run: (store) => store.resetLegacySubagentRuntimeEvents() },
  { version: 26, run: (store) => store.createDatasetImportTables() },
  { version: 28, run: (store) => store.createSidebarFileBookmarkTables() },
  { version: 29, run: (store) => store.createModelBuildDraftTables() },
  { version: 30, run: (store) => store.createModelProjectTables() },
  { version: 31, run: (store) => store.createModelLifecycleTables() },
  {
    version: 32,
    run: (store) => store.createTrainingTables(),
  },
  {
    version: 33,
    run: (store) => store.retireGoalAndInsightsStorage(),
  },
  {
    version: 34,
    run: async () => undefined,
  },
  {
    version: 35,
    run: (store) => store.createWorkEvidenceTables(),
  },
  {
    version: 36,
    run: (store) => store.createHarnessWorkspaceTables(),
  },
  {
    version: 37,
    run: (store) => store.createHarnessWorkspaceTables(),
  },
  {
    version: 38,
    run: (store) => store.createHarnessWorkspaceTables(),
  },
  {
    version: 39,
    run: (store) => store.createHarnessWorkspaceTables(),
  },
  {
    version: 40,
    run: (store) => store.createHarnessWorkspaceTables(),
  },
  {
    version: 41,
    run: (store) => store.createTrainingTables(),
  },
  {
    version: 42,
    run: (store) => store.retireLegacyHarnessBenchmarkRuns(),
  },
  {
    version: 43,
    run: (store) => store.createHarnessWorkspaceTables(),
  },
  {
    version: 44,
    run: (store) => store.createModelUsageTables(),
  },
  {
    version: 45,
    run: (store) => store.createPreferenceComparisonTables(),
  },
  {
    version: 46,
    run: (store) => store.createTasksetDraftTables(),
  },
  {
    version: 47,
    run: (store) => store.createTrainingTables(),
  },
  {
    // Existing stores may already be at v47 from before Reward Model rows
    // were added to TRAINING_TABLES_SQL. Re-run the idempotent table builder
    // so those stores receive the new lifecycle tables on startup.
    version: 48,
    run: (store) => store.createTrainingTables(),
  },
  {
    version: 49,
    run: (store) => store.consolidateModelProjectTrainingSetup(),
  },
  {
    version: 50,
    run: (store) => store.repairUnverifiableLearnedPreferenceBindings(),
  },
  {
    version: 51,
    run: (store) => store.createTrainingTables(),
  },
  {
    version: 52,
    run: (store) => store.allowModelRunsWithoutVersion(),
  },
];
