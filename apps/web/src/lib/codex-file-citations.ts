export type CodexFileCitation = { path: string; label: string; end: number };

/** Parse only the file directive; quoted code is handled before this by Markdown. */
export function codexFileCitationAt(content: string, start: number): CodexFileCitation | null {
  const prefix = /^::?codex-file-citation\{/.exec(content.slice(start))?.[0];
  if (!prefix) return null;
  let index = start + prefix.length;
  const attributes: Record<string, string> = {};
  while (index < content.length) {
    const whitespace = /^\s*/.exec(content.slice(index))![0];
    index += whitespace.length;
    if (content[index] === "}") {
      const path = attributes.path;
      if (!path || /[\0\r\n]/.test(path) || /^[a-z][a-z\d+.-]*:\/\//i.test(path)) return null;
      return { path, label: attributes.title || path.replaceAll("\\", "/").split("/").at(-1) || path, end: index + 1 };
    }
    const attribute = /^([a-zA-Z][\w-]*)\s*=\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/.exec(content.slice(index));
    if (!attribute) return null;
    try {
      attributes[attribute[1]!] = attribute[2]!.startsWith('"')
        ? JSON.parse(attribute[2]!) as string
        : attribute[2]!.slice(1, -1).replace(/\\(['\\])/g, "$1");
    } catch { return null; }
    index += attribute[0].length;
  }
  return null;
}
