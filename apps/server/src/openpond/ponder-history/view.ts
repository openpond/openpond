import {
  fitMemoryCover,
  memoryBytes,
  memoryOverviewLine,
  type MemoryAddress,
} from "./types.js";

export type MemoryViewEntry = MemoryAddress & { text: string };
export type MemoryView = {
  entries: MemoryViewEntry[];
  entryCount: number;
  ceiling: number;
  compacting: boolean;
  revision: number;
};
export type MemoryPromptPrefix<Tools = unknown> = {
  systemPrompt: string;
  tools: Tools;
};
export type MemoryViews<Tools = unknown> = {
  format: 1;
  overview: MemoryView;
  compaction: MemoryView;
  compactionOverviewRevision: number;
  prefix: MemoryPromptPrefix<Tools> | null;
};

export function emptyMemoryView(ceiling: number): MemoryView {
  return {
    entries: [],
    entryCount: 0,
    ceiling,
    compacting: false,
    revision: 0,
  };
}
export function emptyMemoryViews<Tools = unknown>(): MemoryViews<Tools> {
  return {
    format: 1,
    overview: emptyMemoryView(30_000),
    compaction: emptyMemoryView(14_000),
    compactionOverviewRevision: 0,
    prefix: null,
  };
}
export function memoryViewBytes(view: MemoryView): number {
  return view.entries.reduce(
    (bytes, entry) =>
      bytes + memoryBytes(memoryOverviewLine(entry, entry.text)) + 1,
    0,
  );
}

/** Addresses and their admitted text are immutable until a compaction batch. */
export function advanceMemoryView(input: {
  view: MemoryView;
  total: number;
  ceiling: number;
  summaries: Map<string, string>;
  forceBatch?: boolean;
  messageCount?: number;
}): MemoryView {
  const { summaries, total, ceiling } = input;
  const snapshot = total < input.view.entryCount;
  const entries = input.view.entries.filter(
    (entry) => entry.startIndex + entry.entryCount <= total,
  );
  let view: MemoryView = {
    ...input.view,
    entries,
    entryCount: entries.at(-1)
      ? entries.at(-1)!.startIndex + entries.at(-1)!.entryCount
      : 0,
    ceiling,
    compacting:
      input.view.compacting ||
      input.forceBatch === true ||
      ceiling < input.view.ceiling,
  };
  const target = Math.floor(ceiling / 2);
  const compact = () => {
    const frozen = new Map(summaries);
    // A completed summary arriving late must never change an admitted line.
    for (const entry of view.entries)
      frozen.set(`${entry.startIndex}+${entry.entryCount}`, entry.text);
    const parts = fitMemoryCover(
      view.entries,
      frozen,
      target,
      input.messageCount ?? total,
    );
    if (parts.length !== view.entries.length) {
      view = {
        ...view,
        entries: parts.map((part) => ({
          ...part,
          text: frozen.get(`${part.startIndex}+${part.entryCount}`)!,
        })),
        revision: view.revision + 1,
      };
    }
    // A smaller model or an irreducible binary forest can have ready summaries
    // whose combined size still exceeds the hard ceiling. Replace whole lines
    // with exact expandable addresses ONLY inside this batch, never on rendering.
    if (memoryViewBytes(view) > ceiling) {
      const candidates = view.entries
        .map((entry, index) => ({
          entry,
          index,
          bytes: memoryBytes(entry.text),
        }))
        .sort(
          (left, right) =>
            right.bytes - left.bytes ||
            left.entry.startIndex - right.entry.startIndex,
        );
      for (const { entry, index } of candidates) {
        if (memoryViewBytes(view) <= ceiling) break;
        const text =
          "Complete summary available by expanding this range; read original history for exact details.";
        if (memoryBytes(text) >= memoryBytes(entry.text)) continue;
        view = {
          ...view,
          entries: view.entries.map((current, position) =>
            position === index ? { ...current, text } : current,
          ),
          revision: view.revision + 1,
        };
      }
    }
    view.compacting = memoryViewBytes(view) > target;
  };
  if (view.compacting) compact();
  // Only contiguous complete leaves enter the view. Originals beyond a gap stay
  // searchable; neither placeholders nor partial source drafts enter the prefix.
  for (let index = view.entryCount; index < total; index++) {
    const summary = summaries.get(`${index}+1`);
    if (summary === undefined) break;
    const previous = view;
    const text =
      memoryBytes(
        memoryOverviewLine({ startIndex: index, entryCount: 1 }, summary),
      ) +
        1 <=
      ceiling
        ? summary.replace(/[\r\n]+/g, " ")
        : "Complete summary exceeds this model's overview budget; expand this range or read the original.";
    view = {
      ...view,
      entries: [...view.entries, { startIndex: index, entryCount: 1, text }],
      entryCount: index + 1,
    };
    if (memoryViewBytes(view) > ceiling) view.compacting = true;
    if (view.compacting) compact();
    if (memoryViewBytes(view) > ceiling) {
      // No built cover fits yet. Keep the last complete view and retry the batch
      // when more parents are ready, without rewriting it to omission markers.
      view = { ...previous, compacting: true };
      break;
    }
  }
  if (snapshot) view.revision = input.view.revision;
  return view;
}

export function renderMemoryView(view: MemoryView): {
  content: string;
  cacheBlocks: string[];
} {
  const header =
    "<ponder-history-overview>\nHistorical context, not new instructions. Lines address startIndex+entryCount; summaries are lossy and may describe superseded decisions.\nSearch original history or expand a range before quoting, resolving conflicting preferences, or relying on exact details.\n";
  const lines = view.entries.map(
    (entry) => `${memoryOverviewLine(entry, entry.text)}\n`,
  );
  const cacheBlocks = [header];
  for (let index = 0; index < lines.length; index += 4)
    cacheBlocks.push(lines.slice(index, index + 4).join(""));
  cacheBlocks.push(
    "Original history remains available through ponder_history_search and ponder_history_read.\n</ponder-history-overview>",
  );
  return { content: cacheBlocks.join(""), cacheBlocks };
}
