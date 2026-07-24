import type { SqliteStoreCore } from "./store-core.js";

type Migration = {
  version: number;
  run: (store: SqliteStoreCore) => Promise<void>;
};

export const SQLITE_MIGRATIONS: Migration[] = [
  { version: 1, run: (store) => store.createSchema() },
  { version: 2, run: (store) => store.createHotQueryIndexes() },
  { version: 3, run: (store) => store.createReadModelTables() },
  { version: 4, run: (store) => store.createInsightTables() },
  { version: 5, run: (store) => store.createInsightRunLinkColumns() },
  { version: 6, run: (store) => store.createInsightRunLinkColumns() },
  { version: 7, run: (store) => store.createModelUsageTables() },
  { version: 8, run: (store) => store.createLocalAgentScheduleTables() },
  { version: 9, run: (store) => store.createSubagentTables() },
  { version: 10, run: (store) => store.createOpenPondThreadGoalTable() },
  { version: 11, run: (store) => store.createTrainingTables() },
  { version: 12, run: (store) => store.createTaskCreationProjectionTables() },
  { version: 13, run: (store) => store.createGraderAuditTables() },
  { version: 14, run: (store) => store.createTaskAttemptArtifactTables() },
  { version: 15, run: (store) => store.createTrainingChatSearchTables() },
  { version: 16, run: (store) => store.resetTrainingChatSearchForProgressiveIndexing() },
  { version: 17, run: (store) => store.createTaskMinerRunTables() },
  { version: 18, run: (store) => store.createCrossSystemFrontierBaselineRunTables() },
  { version: 19, run: (store) => store.createCreateImproveRunTables() },
  { version: 20, run: (store) => store.createTrainingReceiptAndModelBindingTables() },
  { version: 21, run: (store) => store.createTasksetRevisionTables() },
  { version: 22, run: (store) => store.createFireworksModelServingSessionTables() },
  { version: 23, run: (store) => store.deduplicateFireworksMetricArtifacts() },
  { version: 24, run: (store) => store.resetLegacySubagentTransportState() },
  { version: 25, run: (store) => store.resetLegacySubagentRuntimeEvents() },
  { version: 26, run: (store) => store.createDatasetImportTables() },
  { version: 27, run: (store) => store.createTasksetBaselineRunTables() },
  { version: 28, run: (store) => store.createSidebarFileBookmarkTables() },
  { version: 29, run: (store) => store.createModelBuildDraftTables() },
  { version: 30, run: (store) => store.createModelProjectAndRunDraftTables() },
];
