import { describe, expect, test } from "vitest";
import {
  parseBlocks,
  renderableStreamingMarkdown,
} from "../apps/web/src/components/chat/MarkdownBlocks";

describe("chat Markdown blocks", () => {
  test("keeps loose ordered-list items in one list with source ordinals", () => {
    expect(
      parseBlocks("1. First item\n\n2. Second item\n\n3. Third item")
    ).toEqual([
      {
        type: "list",
        ordered: true,
        start: 1,
        items: [
          { content: "First item", checked: null, ordinal: 1 },
          { content: "Second item", checked: null, ordinal: 2 },
          { content: "Third item", checked: null, ordinal: 3 },
        ],
      },
    ]);
  });

  test("preserves a non-one ordered-list start", () => {
    expect(parseBlocks("4. Fourth\n5. Fifth")).toMatchObject([
      {
        type: "list",
        ordered: true,
        start: 4,
        items: [{ ordinal: 4 }, { ordinal: 5 }],
      },
    ]);
  });

  test("parses hash-prefixed Markdown as headings", () => {
    expect(parseBlocks("# Main heading\n\n## Smaller heading")).toEqual([
      { type: "heading", level: 1, content: "Main heading" },
      { type: "heading", level: 2, content: "Smaller heading" },
    ]);
  });

  test("holds incomplete block markers until their content starts", () => {
    expect(renderableStreamingMarkdown("#", false)).toBe("");
    expect(renderableStreamingMarkdown("Intro\n\n## ", false)).toBe(
      "Intro\n\n"
    );
    expect(renderableStreamingMarkdown("# Heading", false)).toBe(
      "# Heading"
    );
    expect(renderableStreamingMarkdown("#", true)).toBe("#");
  });
});
