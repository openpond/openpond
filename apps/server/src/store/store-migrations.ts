export type SqliteMigrationTarget = {
  createSchema(): Promise<void>;
  createHotQueryIndexes(): Promise<void>;
  createReadModelTables(): Promise<void>;
  createInsightTables(): Promise<void>;
  createInsightRunLinkColumns(): Promise<void>;
  createModelUsageTables(): Promise<void>;
  createLocalAgentScheduleTables(): Promise<void>;
  createSubagentTables(): Promise<void>;
  createOpenPondThreadGoalTable(): Promise<void>;
  createTrainingTables(): Promise<void>;
  createTaskCreationProjectionTables(): Promise<void>;
  createGraderAuditTables(): Promise<void>;
  createTaskAttemptArtifactTables(): Promise<void>;
  createTrainingChatSearchTables(): Promise<void>;
  resetTrainingChatSearchForProgressiveIndexing(): Promise<void>;
  createTaskMinerRunTables(): Promise<void>;
  createCrossSystemFrontierBaselineRunTables(): Promise<void>;
  resetLegacySubagentTransportState(): Promise<void>;
  resetLegacySubagentRuntimeEvents(): Promise<void>;
};

export type SqliteMigration = {
  version: number;
  run: (store: SqliteMigrationTarget) => Promise<void>;
};

export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    run: (store) => store.createSchema(),
  },
  {
    version: 2,
    run: (store) => store.createHotQueryIndexes(),
  },
  {
    version: 3,
    run: (store) => store.createReadModelTables(),
  },
  {
    version: 4,
    run: (store) => store.createInsightTables(),
  },
  {
    version: 5,
    run: (store) => store.createInsightRunLinkColumns(),
  },
  {
    version: 6,
    run: (store) => store.createInsightRunLinkColumns(),
  },
  {
    version: 7,
    run: (store) => store.createModelUsageTables(),
  },
  {
    version: 8,
    run: (store) => store.createLocalAgentScheduleTables(),
  },
  {
    version: 9,
    run: (store) => store.createSubagentTables(),
  },
  {
    version: 10,
    run: (store) => store.createOpenPondThreadGoalTable(),
  },
  {
    version: 11,
    run: (store) => store.createTrainingTables(),
  },
  {
    version: 12,
    run: (store) => store.createTaskCreationProjectionTables(),
  },
  {
    version: 13,
    run: (store) => store.createGraderAuditTables(),
  },
  {
    version: 14,
    run: (store) => store.createTaskAttemptArtifactTables(),
  },
  {
    version: 15,
    run: (store) => store.createTrainingChatSearchTables(),
  },
  {
    version: 16,
    run: (store) => store.resetTrainingChatSearchForProgressiveIndexing(),
  },
  {
    version: 17,
    run: (store) => store.createTaskMinerRunTables(),
  },
  {
    version: 18,
    run: (store) => store.createCrossSystemFrontierBaselineRunTables(),
  },
  {
    version: 19,
    run: (store) => store.resetLegacySubagentTransportState(),
  },
  {
    version: 20,
    run: (store) => store.resetLegacySubagentRuntimeEvents(),
  },
];
