import { useMemo } from "react";
import { renderToString } from "katex";

export function MarkdownMath({
  display = false,
  source,
}: {
  display?: boolean;
  source: string;
}) {
  const markup = useMemo(
    () =>
      renderToString(source, {
        displayMode: display,
        output: "htmlAndMathml",
        strict: "ignore",
        throwOnError: false,
        trust: false,
      }),
    [display, source],
  );
  const Tag = display ? "div" : "span";

  return (
    <Tag
      className={display ? "markdown-math-block" : "markdown-math-inline"}
      // KaTeX escapes untrusted input and trust remains disabled above.
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}
