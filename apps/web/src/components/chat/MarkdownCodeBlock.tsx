import { memo, useEffect, useState } from "react";
import { Check, Code2, Copy, WrapText } from "../icons";
import { copyToClipboard } from "../../lib/clipboard";

const LANGUAGE_LABELS: Record<string, string> = {
  bash: "Bash",
  css: "CSS",
  html: "HTML",
  javascript: "JavaScript",
  js: "JavaScript",
  json: "JSON",
  jsx: "JSX",
  markdown: "Markdown",
  md: "Markdown",
  python: "Python",
  py: "Python",
  sh: "Shell",
  shell: "Shell",
  sql: "SQL",
  ts: "TypeScript",
  tsx: "TSX",
  typescript: "TypeScript",
  yaml: "YAML",
  yml: "YAML",
};

export const MarkdownCodeBlock = memo(function MarkdownCodeBlock({
  content,
  language,
}: {
  content: string;
  language?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [wrapLines, setWrapLines] = useState(false);
  const languageLabel = formatCodeLanguage(language);

  useEffect(() => {
    if (!copied) return undefined;
    const timeout = window.setTimeout(() => setCopied(false), 1_800);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  return (
    <section
      className={`markdown-code-block${wrapLines ? " wrap-lines" : ""}`}
      aria-label={`${languageLabel} code block`}
    >
      <header className="markdown-code-header">
        <span className="markdown-code-language">
          <Code2 aria-hidden size={15} strokeWidth={1.8} />
          <span>{languageLabel}</span>
        </span>
        <span className="markdown-code-actions">
          <button
            aria-label={wrapLines ? "Stop wrapping code" : "Wrap code"}
            aria-pressed={wrapLines}
            className="markdown-code-action"
            title={wrapLines ? "Stop wrapping" : "Wrap lines"}
            type="button"
            onClick={() => setWrapLines((current) => !current)}
          >
            <WrapText aria-hidden size={15} />
          </button>
          <button
            aria-label={copied ? "Code copied" : "Copy code"}
            className="markdown-code-action"
            title={copied ? "Copied" : "Copy code"}
            type="button"
            onClick={() => {
              void copyToClipboard(content).then((didCopy) => {
                if (didCopy) setCopied(true);
              });
            }}
          >
            {copied ? (
              <Check aria-hidden size={15} />
            ) : (
              <Copy aria-hidden size={15} />
            )}
          </button>
        </span>
      </header>
      <pre className="markdown-code-content">
        <code>{content}</code>
      </pre>
    </section>
  );
});

function formatCodeLanguage(language?: string): string {
  const normalized = language?.trim().toLowerCase();
  if (!normalized) return "Code";
  return LANGUAGE_LABELS[normalized] ??
    normalized.charAt(0).toUpperCase() + normalized.slice(1);
}
