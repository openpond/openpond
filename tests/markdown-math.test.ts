import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { renderableStreamingMarkdown } from "../apps/web/src/components/chat/MarkdownBlocks";
import { MarkdownText } from "../apps/web/src/components/chat/MarkdownText";
import { streamingMarkdownSegments } from "../apps/web/src/components/chat/StreamingMarkdownText";

describe("markdown math rendering", () => {
  test("typesets inline and centered display LaTeX without exposing delimiters", () => {
    const markup = renderToStaticMarkup(
      createElement(MarkdownText, {
        content: [
          "Training adapts \\(A\\) and \\(B\\).",
          "",
          "\\[",
          "W' = W + \\frac{\\alpha}{r}BA",
          "\\]",
        ].join("\n"),
      }),
    );

    expect(markup.match(/<math\b/g)).toHaveLength(3);
    expect(markup).toContain('display="block"');
    expect(markup).toContain("mfrac");
    expect(markup).not.toContain("\\[");
    expect(markup).not.toContain("\\]");

    const streaming = "Before.\n\n\\[\na + b\n\nc + d";
    expect(renderableStreamingMarkdown(streaming, false)).toBe("Before.\n\n");
    expect(streamingMarkdownSegments(streaming, false)).toEqual({
      finalized: "Before.\n\n",
      mutable: "\\[\na + b\n\nc + d",
    });
  });
});
