import { describe, expect, test } from "bun:test";
import { matchChatFilePathAt, normalizeChatFilePath } from "../apps/web/src/lib/chat-file-links";

describe("chat file links", () => {
  test("normalizes relative file paths and line suffixes", () => {
    expect(normalizeChatFilePath("./apps/web/src/App.tsx:42")).toEqual({
      displayPath: "./apps/web/src/App.tsx:42",
      path: "apps/web/src/App.tsx",
    });
  });

  test("converts absolute workspace paths to repo-relative paths", () => {
    expect(
      normalizeChatFilePath("/home/glu/Projects/all/openpond-app/apps/web/src/App.tsx", {
        workspaceRootPath: "/home/glu/Projects/all/openpond-app",
      }),
    ).toEqual({
      displayPath: "/home/glu/Projects/all/openpond-app/apps/web/src/App.tsx",
      path: "apps/web/src/App.tsx",
    });
  });

  test("detects likely file paths in prose", () => {
    const content = "Open apps/web/src/components/chat/MarkdownText.tsx, then update tests/chat-file-links.test.ts.";
    const first = matchChatFilePathAt(content, content.indexOf("apps/"));
    const second = matchChatFilePathAt(content, content.indexOf("tests/"));
    expect(first).toMatchObject({
      displayPath: "apps/web/src/components/chat/MarkdownText.tsx",
      path: "apps/web/src/components/chat/MarkdownText.tsx",
    });
    expect(second).toMatchObject({
      displayPath: "tests/chat-file-links.test.ts",
      path: "tests/chat-file-links.test.ts",
    });
  });

  test("does not treat domains or ordinary words as file paths", () => {
    expect(normalizeChatFilePath("example.com")).toBeNull();
    expect(normalizeChatFilePath("not-a-file")).toBeNull();
  });
});
