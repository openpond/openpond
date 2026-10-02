/** Work tools expose the current operation, not the accumulated sandbox audit
 * history. The complete control-plane record remains available to its owner. */
export function workModelData(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const data = value as Record<string, unknown>;
  const sandbox = data.sandbox;
  if (!sandbox || typeof sandbox !== "object" || Array.isArray(sandbox)) return data;
  const record = sandbox as Record<string, unknown>;
  return {
    ...data,
    sandbox: {
      id: record.id,
      name: record.name,
      state: record.state,
      resources: record.resources,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    },
  };
}
