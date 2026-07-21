export function extractFinalAnswer(value: string): string | null {
  const boxed = [...value.matchAll(/\\boxed\{([^{}]+)\}/g)].at(-1)?.[1];
  const hashAnswer = value.match(/####\s*([^\n\r]+)/)?.[1];
  const answerLabel = value.match(
    /(?:final\s+answer|answer)\s*(?::|is|=)\s*([^\n\r]+)/i,
  )?.[1];
  const selected = boxed ?? hashAnswer ?? answerLabel;
  if (!selected?.trim()) return null;
  return selected
    .normalize("NFKC")
    .trim()
    .replace(/^\$+|\$+$/g, "")
    .replace(/^\\\(|\\\)$/g, "")
    .replace(/[,，]/g, "")
    .replace(/[.\s]+$/g, "")
    .replace(/\s+/g, " ");
}
