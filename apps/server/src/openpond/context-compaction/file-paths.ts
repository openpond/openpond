export function extractCompactionFilePaths(value: string): string[] {
  const paths = new Set<string>();
  const durableRefPattern = /\b(?:workspace|sandbox):(file|dir):[^\s,)"']+/g;
  for (const match of value.matchAll(durableRefPattern)) {
    paths.add(cleanTrailingPunctuation(match[0]));
  }
  const repoPathPattern = /\b(?:apps|packages|tests|scripts|docs|config|src)\/[A-Za-z0-9._/@+-]+/g;
  for (const match of value.matchAll(repoPathPattern)) {
    paths.add(cleanTrailingPunctuation(match[0]));
  }
  const absolutePathPattern = /(?:^|\s)(\/(?:[A-Za-z0-9._@+-]+\/){1,}[A-Za-z0-9._@+-]+)/g;
  for (const match of value.matchAll(absolutePathPattern)) {
    paths.add(cleanTrailingPunctuation(match[1]!));
  }
  const values = [...paths].filter(Boolean);
  return values
    .filter((candidate) =>
      candidate.startsWith("/")
      || candidate.startsWith("workspace:")
      || candidate.startsWith("sandbox:")
      || !values.some((other) => other.startsWith("/") && other.endsWith(`/${candidate}`))
    )
    .slice(0, 20);
}

function cleanTrailingPunctuation(value: string): string {
  return value.replace(/[.,;:!?]+$/, "");
}
