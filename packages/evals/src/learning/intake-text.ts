/** Preserve the original UTF-8 bytes, including a leading BOM. Binary or invalid
 * UTF-8 input must not silently turn into replacement characters in evidence. */
export function decodeTaskIntakeText(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error("Import files must contain valid UTF-8 text. Binary attachments are not supported by this import format."); }
}

/** A BOM is a transport marker only at the start of a structured text file. */
export function structuredIntakeText(text: string): string {
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}
