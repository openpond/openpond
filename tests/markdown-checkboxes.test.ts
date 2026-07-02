import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "bun:test";
import { MarkdownText } from "../apps/web/src/components/chat/MarkdownText";

function renderMarkdown(content: string): string {
  return renderToStaticMarkup(createElement(MarkdownText, { content }));
}

describe("markdown checkbox rendering", () => {
  test("renders unchecked and checked task-list items as disabled checkboxes", () => {
    const markup = renderMarkdown("- [ ] Todo\n- [x] Done");

    expect(markup).toContain("markdown-task-list-item");
    expect(markup).toContain('aria-label="Unchecked item"');
    expect(markup).toContain('aria-label="Checked item"');
    expect(markup).toContain("disabled");
    expect(markup).toContain("Todo");
    expect(markup).toContain("Done");
  });

  test("renders ordered task-list items as checkbox rows", () => {
    const markup = renderMarkdown("1. [ ] Ordered");

    expect(markup).toContain("<ol");
    expect(markup).toContain("markdown-task-list-item");
    expect(markup).toContain('aria-label="Unchecked item"');
    expect(markup).toContain("Ordered");
  });

  test("renders bare checkbox tokens inline", () => {
    const markup = renderMarkdown("Bare [ ] and [x]");

    expect(markup).toContain("markdown-checkbox inline");
    expect(markup).toContain('aria-label="Unchecked item"');
    expect(markup).toContain('aria-label="Checked item"');
  });

  test("preserves checkbox tokens inside code spans", () => {
    const markup = renderMarkdown("`[x]`");

    expect(markup).toContain("<code>[x]</code>");
    expect(markup).not.toContain("markdown-checkbox");
  });
});
