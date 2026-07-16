type ExecSql = (sql: string) => Promise<void>;
type RunSql = (sql: string, params: unknown[]) => Promise<void>;

export async function resetLegacySubagentTransportState(exec: ExecSql): Promise<void> {
  // The current runtime replaces the previous semantic review/watcher state
  // machine. Start its generic child-conversation transport with a clean
  // ledger instead of carrying incompatible legacy payloads forward.
  await exec(`
    DELETE FROM subagent_messages;
    DELETE FROM subagent_runs;
  `);
}

export async function resetLegacySubagentRuntimeEvents(
  run: RunSql,
  rebuildReadModels: () => Promise<void>,
): Promise<void> {
  await run("DELETE FROM events WHERE name LIKE 'subagent.%'", []);
  await rebuildReadModels();
}
