export const PONDER_MEMORY_VERSION = 2;
export const MEMORY_SUMMARY_BYTES = 2_400;
export const MEMORY_OVERVIEW_BYTES = 32_000;
export const MEMORY_RECENT_BYTES = 24_000;
export const MEMORY_READ_CHARS = 12_000;
export type MemoryAddress = { startIndex: number; entryCount: number };

export function assertMemoryAddress(address: MemoryAddress): void {
  const { startIndex, entryCount } = address;
  if (
    !Number.isSafeInteger(startIndex) ||
    startIndex < 0 ||
    !Number.isSafeInteger(entryCount) ||
    entryCount < 1 ||
    entryCount > 2 ** 30 ||
    Math.log2(entryCount) % 1 !== 0 ||
    startIndex % entryCount !== 0
  ) {
    throw new Error("ponder_memory_address_invalid");
  }
}

/** UTF-8 bytes are a storage budget, not an assertion about a model's token count. */
export function memoryBytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** Balanced aligned cover with more resolution near the present, independent of summary text. */
export function memoryCover(total: number, from = 0): MemoryAddress[] {
  const parts: MemoryAddress[] = [];
  for (let startIndex = from; startIndex < total;) {
    const remaining = total - startIndex;
    let entryCount =
      2 ** Math.floor(Math.log2(Math.max(1, Math.floor(remaining / 8))));
    while (entryCount > remaining || startIndex % entryCount !== 0)
      entryCount /= 2;
    parts.push({ startIndex, entryCount });
    startIndex += entryCount;
  }
  return parts;
}

export function memoryAncestors(
  parts: MemoryAddress[],
  total: number,
): MemoryAddress[] {
  const addresses = new Map<string, MemoryAddress>();
  for (const part of parts) {
    let entryCount = part.entryCount;
    while (entryCount <= total) {
      const startIndex = Math.floor(part.startIndex / entryCount) * entryCount;
      if (startIndex + entryCount <= total)
        addresses.set(`${startIndex}+${entryCount}`, {
          startIndex,
          entryCount,
        });
      entryCount *= 2;
    }
  }
  return [...addresses.values()];
}

export function fitMemoryCover(
  parts: MemoryAddress[],
  summaries: Map<string, string>,
  budget: number,
  messageCount?: number,
): MemoryAddress[] {
  const result = [...parts];
  const size = (part: MemoryAddress) =>
    memoryBytes(
      memoryOverviewLine(
        part,
        summaries.get(`${part.startIndex}+${part.entryCount}`),
      ),
    ) + 1;
  let bytes = result.reduce((sum, part) => sum + size(part), 0);
  const total =
    messageCount ??
    (parts.at(-1) ? parts.at(-1)!.startIndex + parts.at(-1)!.entryCount : 0);
  while (bytes > budget) {
    let bestIndex = -1;
    let bestAge = -1;
    for (let index = 0; index < result.length - 1; index++) {
      const left = result[index]!;
      const right = result[index + 1]!;
      if (
        left.entryCount !== right.entryCount ||
        left.startIndex % (left.entryCount * 2) !== 0 ||
        right.startIndex !== left.startIndex + left.entryCount
      )
        continue;
      if (!summaries.has(`${left.startIndex}+${left.entryCount * 2}`)) continue;
      // Age is measured from the pair's LAST message in units of child width.
      // Measuring from the first incorrectly favors rewriting older, larger ranges.
      const last = left.startIndex + 2 * left.entryCount - 1;
      const age = (total - last) / left.entryCount;
      if (age > bestAge) {
        bestAge = age;
        bestIndex = index;
      }
    }
    if (bestIndex < 0) break;
    const left = result[bestIndex]!;
    const parent = {
      startIndex: left.startIndex,
      entryCount: left.entryCount * 2,
    };
    bytes += size(parent) - size(left) - size(result[bestIndex + 1]!);
    result.splice(bestIndex, 2, parent);
  }
  return result;
}

export function memoryOverviewLine(
  part: MemoryAddress,
  summary: string | undefined,
): string {
  return `${part.startIndex}+${part.entryCount}|${summary?.replace(/[\r\n]+/g, " ") ?? "Summary pending; search originals before using details from this range."}`;
}
