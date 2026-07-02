type SyntaxToken = {
  text: string;
  kind: "plain" | "comment" | "keyword" | "string" | "number" | "type" | "property" | "operator";
};

const languageByExtension: Record<string, string> = {
  cjs: "typescript",
  css: "css",
  html: "html",
  js: "typescript",
  json: "json",
  jsx: "typescript",
  md: "markdown",
  mjs: "typescript",
  py: "python",
  sh: "shell",
  ts: "typescript",
  tsx: "typescript",
  yaml: "yaml",
  yml: "yaml",
};

export function languageForPath(path: string): string {
  const fileName = path.split("/").pop()?.toLowerCase() ?? "";
  if (fileName === "dockerfile") return "shell";
  if (fileName === "readme" || fileName === "readme.md") return "markdown";
  const extension = fileName.includes(".") ? fileName.split(".").pop() ?? "" : "";
  return languageByExtension[extension] ?? "text";
}

function tokenizeLine(line: string, language: string): SyntaxToken[] {
  if (!line) return [{ text: " ", kind: "plain" }];
  if (language === "markdown") return tokenizeMarkdownLine(line);
  if (language === "json") {
    return tokenizePatternLine(
      line,
      /("(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|[-]?\b\d+(?:\.\d+)?\b|\btrue\b|\bfalse\b|\bnull\b|[{}[\]:,])/g
    );
  }
  if (language === "css") {
    return tokenizePatternLine(
      line,
      /(\/\*.*?\*\/|#[\da-fA-F]{3,8}\b|--[\w-]+|[.#]?[\w-]+(?=\s*:)|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw)?\b|[{}():;,])/g
    );
  }
  if (language === "html") {
    return tokenizePatternLine(
      line,
      /(<!--.*?-->|<\/?[\w-]+|[\w:-]+(?==)|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[<>/=])/g
    );
  }
  if (language === "shell") {
    return tokenizePatternLine(
      line,
      /(#.*$|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:cd|cp|export|git|npm|pnpm|bun|yarn|rm|mkdir|test|if|then|fi|for|do|done|echo)\b|\$[\w_]+|&&|\|\||[|&;=])/g
    );
  }
  if (language === "python") {
    return tokenizePatternLine(
      line,
      /(#.*$|"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:class|def|return|if|elif|else|for|while|try|except|finally|with|as|import|from|None|True|False|async|await|lambda|yield)\b|\b[A-Z][\w]*\b|\b\d+(?:\.\d+)?\b|[+\-*/%=<>!&|.:,()[\]{}]+)/g
    );
  }
  return tokenizePatternLine(
    line,
    /(\/\/.*$|\/\*.*?\*\/|`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:abstract|as|async|await|boolean|break|case|catch|class|const|continue|default|else|enum|export|extends|false|finally|for|from|function|if|import|in|interface|let|new|null|number|of|return|string|switch|throw|true|try|type|undefined|void|while)\b|\b[A-Z][\w]*\b|\b\d+(?:\.\d+)?\b|[+\-*/%=<>!&|?:.,()[\]{}]+)/g
  );
}

function tokenizeMarkdownLine(line: string): SyntaxToken[] {
  if (/^\s{0,3}#{1,6}\s/.test(line)) return [{ text: line, kind: "keyword" }];
  if (/^\s*[-*+]\s/.test(line)) return [{ text: line, kind: "property" }];
  return tokenizePatternLine(line, /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)|https?:\/\/\S+)/g);
}

function tokenKindFor(value: string): SyntaxToken["kind"] {
  if (/^(\/\/|#|\/\*|<!--)/.test(value)) return "comment";
  if (/^["'`]/.test(value)) return "string";
  if (/^[-]?\d/.test(value) || /^#[\da-fA-F]{3,8}\b/.test(value)) return "number";
  if (/^\b[A-Z]/.test(value)) return "type";
  if (/^[.#]?[\w-]+$/.test(value) && value.includes("-")) return "property";
  if (/^(?:[{}()[\],.:;<>/=+\-*&|!?%]+)$/.test(value)) return "operator";
  if (/^(?:--|\$)/.test(value)) return "property";
  return "keyword";
}

function tokenizePatternLine(line: string, pattern: RegExp): SyntaxToken[] {
  const tokens: SyntaxToken[] = [];
  let cursor = 0;
  for (const match of line.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) tokens.push({ text: line.slice(cursor, index), kind: "plain" });
    const text = match[0];
    tokens.push({ text, kind: tokenKindFor(text) });
    cursor = index + text.length;
    if (/^(\/\/|#|<!--)/.test(text)) break;
  }
  if (cursor < line.length) tokens.push({ text: line.slice(cursor), kind: "plain" });
  return tokens.length > 0 ? tokens : [{ text: line, kind: "plain" }];
}

export function SyntaxLine({ language, text }: { language: string; text: string }) {
  return (
    <>
      {tokenizeLine(text, language).map((token, index) => (
        <span className={`syntax-token ${token.kind}`} key={`${index}-${token.text}`}>
          {token.text}
        </span>
      ))}
    </>
  );
}
