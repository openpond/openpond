/** Summaries never emit task contents. Explicit row inspection defaults to train
 * and requires a split/ID match, keeping held-out rows out of casual reviews. */
export function inspectModelDatasetInputs(raw: unknown, options: Record<string, string | boolean>) {
  const value = raw as { sources?: Record<string, unknown>[] };
  if (!Array.isArray(value?.sources)) throw new Error("Model input response is unavailable.");
  const view = typeof options.view === "string" ? options.view : "summary";
  if (!["summary", "tasks", "graders"].includes(view)) throw new Error("Use --view summary, tasks or graders.");
  const role = typeof options.role === "string" ? options.role : view === "summary" ? undefined : "training";
  if (role && !["training", "evaluation"].includes(role)) throw new Error("Use --role training or evaluation.");
  const split = typeof options.split === "string" ? options.split : "train";
  const taskId = typeof options.taskId === "string" ? options.taskId : undefined;
  const limit = options.limit === undefined ? 20 : Number(options.limit);
  const offset = options.offset === undefined ? 0 : Number(options.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) throw new Error("Use --limit 1..100 and a nonnegative --offset.");
  if (!["train", "validation", "test", "frozen_eval"].includes(split)) throw new Error("Choose an exact task split.");
  return { sources: value.sources.filter(source => !role || source.role === role).map(source => {
    const taskset = source.taskset as { id: string; profileId: string; name: string; revision: number; contentHash: string; tasks: { id: string; split: string }[]; graders: { id: string; kind: string; version: string }[] } | undefined;
    const dataset = source.dataset as Record<string, unknown> | undefined;
    if (!taskset) {
      const { rows: _rows, ...summary } = dataset ?? {};
      return { ...source, ...(dataset ? { dataset: summary } : {}), inspection: dataset ? "Use datasets read with the returned exact revision." : "Use the exact hosted release through its authorized dataset tools." };
    }
    const { tasks, graders, ...pin } = taskset;
    const splits: Record<string, number> = {};
    for (const task of tasks) splits[task.split] = (splits[task.split] ?? 0) + 1;
    const filtered = tasks.filter(task => task.split === split && (!taskId || task.id === taskId));
    if (view === "tasks" && taskId && !filtered.length) throw new Error("The requested task is not in this exact dataset revision and split.");
    return { role: source.role, name: source.name, taskset: { ...pin, taskCount: tasks.length, splits,
      graders: view === "graders" ? graders : graders.map(({ id, kind, version }) => ({ id, kind, version })),
      ...(view === "tasks" ? { tasks: filtered.slice(offset, offset + limit), page: { split, offset, limit, total: filtered.length, hasMore: offset + limit < filtered.length } } : {}),
    } };
  }) };
}
