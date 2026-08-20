import { describe, expect, test } from "vitest";
import { streamingMarkdownSegments } from "../apps/web/src/components/chat/StreamingMarkdownText";

describe("streamingMarkdownSegments", () => {
  test("keeps completed blocks stable and the active paragraph mutable", () => {
    expect(streamingMarkdownSegments("First paragraph.\n\nSecond para", false)).toEqual({
      finalized: "First paragraph.\n\n",
      mutable: "Second para",
    });
  });

  test("does not split at blank lines inside an open code fence", () => {
    const content = "Intro.\n\n```ts\nconst a = 1;\n\nconst b = 2;";
    expect(streamingMarkdownSegments(content, false)).toEqual({
      finalized: "Intro.\n\n",
      mutable: "```ts\nconst a = 1;\n\nconst b = 2;",
    });
  });

  test("finalizes all content after the stream completes", () => {
    expect(streamingMarkdownSegments("Final answer", true)).toEqual({
      finalized: "Final answer",
      mutable: "",
    });
  });
});
