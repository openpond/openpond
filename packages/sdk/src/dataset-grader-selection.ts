/** Package aliases remain provenance; a released Reward is one scoring choice. */
export type DatasetGraderPin = {
  id: string;
  version: string;
  contentHash: string;
  feedbackKey: string;
  release?: { id: string; revision: number; contentHash: string } | null;
};

export function datasetGraderIdentity(pin: DatasetGraderPin): string {
  return JSON.stringify(pin.release
    ? ["reward", pin.release.id, pin.release.revision, pin.release.contentHash, pin.feedbackKey]
    : ["dataset", pin.id, pin.version, pin.contentHash, pin.feedbackKey]);
}

export function groupDatasetGraders<T extends DatasetGraderPin>(pins: readonly T[]): Array<{ key: string; grader: T; aliases: T[] }> {
  const groups = new Map<string, { key: string; grader: T; aliases: T[] }>();
  for (const pin of pins) {
    const key = datasetGraderIdentity(pin);
    const group = groups.get(key);
    if (group) group.aliases.push(pin);
    else groups.set(key, { key, grader: pin, aliases: [pin] });
  }
  return [...groups.values()];
}

/** Validate selected choices, rather than silently choosing between different
 * graders that would write the same feedback field. Never modifies package pins. */
export function canonicalDatasetGraderSelection<T extends DatasetGraderPin & { mappings?: unknown }>(pins: readonly T[]): T[] {
  const selected = groupDatasetGraders(pins);
  const feedback = new Map<string, string>();
  for (const group of selected) {
    const previous = feedback.get(group.grader.feedbackKey);
    if (previous && previous !== group.key)
      throw new Error(`Different selected grader releases use feedback key "${group.grader.feedbackKey}". Select one, or publish graders with distinct feedback keys.`);
    feedback.set(group.grader.feedbackKey, group.key);
    const mappings = JSON.stringify(group.grader.mappings ?? []);
    if (group.aliases.some(alias => JSON.stringify(alias.mappings ?? []) !== mappings))
      throw new Error(`Aliases of grader "${group.grader.feedbackKey}" have different field mappings. Select one alias and review its mappings.`);
  }
  return selected.map(group => group.grader);
}
