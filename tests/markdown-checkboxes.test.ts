import { createElement } from "react";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { MarkdownText } from "../apps/web/src/components/chat/MarkdownText";

function renderMarkdown(content: string, props: Partial<ComponentProps<typeof MarkdownText>> = {}): string {
  return renderToStaticMarkup(createElement(MarkdownText, { content, ...props }));
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

  test("renders explicit signed chat attachment markdown images inline", () => {
    const imageUrl =
      "http://127.0.0.1:17876/v1/assets/chat-attachment-image?storageName=OpenPond%20Chat%20signed-out%20failure.png&signature=sig";
    const markup = renderMarkdown(`![OpenPond Chat signed-out failure](${imageUrl})`, {
      connection: { serverUrl: "http://127.0.0.1:17876", token: "token", platform: "test" },
    });

    expect(markup).toContain("markdown-inline-image ready");
    expect(markup).toContain("<img");
    expect(markup).toContain('alt="OpenPond Chat signed-out failure"');
    expect(markup).toContain("/v1/assets/chat-attachment-image");
    expect(markup).not.toContain("markdown-image-link");
    expect(markup).not.toContain("!<");
  });

  test("renders empty-alt markdown images inline", () => {
    const imageUrl =
      "http://127.0.0.1:17876/v1/assets/chat-attachment-image?storageName=empty-alt.png&signature=sig";
    const markup = renderMarkdown(`![](${imageUrl})`, {
      connection: { serverUrl: "http://127.0.0.1:17876", token: "token", platform: "test" },
    });

    expect(markup).toContain("markdown-inline-image ready");
    expect(markup).toContain("<img");
    expect(markup).not.toContain("![]");
  });

  test("renders safe html image tags inline and consumes stray image bang", () => {
    const imageUrl =
      "http://127.0.0.1:17876/v1/assets/chat-attachment-image?storageName=html-image.png&signature=sig";
    const markup = renderMarkdown(`!<img src="${imageUrl}" alt="HTML image" />`, {
      connection: { serverUrl: "http://127.0.0.1:17876", token: "token", platform: "test" },
    });

    expect(markup).toContain("markdown-inline-image ready");
    expect(markup).toContain("<img");
    expect(markup).toContain('alt="HTML image"');
    expect(markup).not.toContain("!&lt;img");
  });

  test("renders public image file paths inside inline code as previews", () => {
    const markup = renderMarkdown(
      "- `apps/web/public/openpond-icon.png`\n- `apps/web/public/connected-apps/github.svg`",
      {
        onOpenFileInSidebar: () => {},
        workspaceRootPath: "/home/glu/Projects/all/openpond",
      },
    );

    expect(markup).toContain("markdown-file-image-reference");
    expect(markup).toContain("markdown-file-image-preview ready");
    expect(markup).toContain(">apps/web/public/openpond-icon.png</a>");
    expect(markup).not.toContain("<code>apps/web/public/openpond-icon.png</code>");
    expect(markup).toContain('src="./openpond-icon.png"');
    expect(markup).toContain('src="./connected-apps/github.svg"');
  });

  test("renders explicit public svg markdown images without showing the alt label", () => {
    const markup = renderMarkdown("![github](apps/web/public/connected-apps/github.svg)", {
      workspaceRootPath: "/home/glu/Projects/all/openpond",
    });

    expect(markup).toContain("markdown-inline-image ready");
    expect(markup).toContain('src="./connected-apps/github.svg"');
    expect(markup).not.toContain("!github");
    expect(markup).not.toContain("markdown-file-image-reference");
  });

  test("renders explicit absolute local markdown images without showing the alt label", () => {
    const markup = renderMarkdown("![screenshot](/tmp/image.png)", {
      connection: { serverUrl: "http://127.0.0.1:17876", token: "token", platform: "test" },
      workspaceRootPath: "/home/glu/Projects/all/openpond",
    });

    expect(markup).toContain("markdown-inline-image loading");
    expect(markup).not.toContain("!screenshot");
    expect(markup).not.toContain("markdown-image-link");
  });

  test("keeps prose references to code-spanned image paths as code", () => {
    const markup = renderMarkdown("I created `/tmp/image.png` for the smoke test.", {
      connection: { serverUrl: "http://127.0.0.1:17876", token: "token", platform: "test" },
      onOpenFileInSidebar: () => {},
      workspaceRootPath: "/home/glu/Projects/all/openpond",
    });

    expect(markup).toContain("<code>/tmp/image.png</code>");
    expect(markup).not.toContain("markdown-inline-image");
    expect(markup).not.toContain("markdown-file-image-reference");
  });

  test("renders bare public image file paths as previews", () => {
    const markup = renderMarkdown("- apps/web/public/openpond-icon.png", {
      onOpenFileInSidebar: () => {},
      workspaceRootPath: "/home/glu/Projects/all/openpond",
    });

    expect(markup).toContain("markdown-file-image-reference");
    expect(markup).toContain("markdown-file-image-preview ready");
    expect(markup).toContain('src="./openpond-icon.png"');
  });

  test("keeps normal image-url markdown links as links", () => {
    const imageUrl =
      "http://127.0.0.1:17876/v1/assets/chat-attachment-image?storageName=OpenPond%20Chat%20signed-out%20failure.png&signature=sig";
    const markup = renderMarkdown(`[OpenPond Chat signed-out failure](${imageUrl})`, {
      connection: { serverUrl: "http://127.0.0.1:17876", token: "token", platform: "test" },
    });

    expect(markup).toContain("markdown-image-link");
    expect(markup).not.toContain("markdown-inline-image");
    expect(markup).not.toContain("<img");
  });


  test("renders inline code resource file refs as clickable file links", () => {
    const markup = renderMarkdown("Open `workspace:file:apps/web/src/components/chat/MarkdownText.tsx` next.", {
      onOpenFileInSidebar: () => {},
    });

    expect(markup).toContain('class="markdown-file-link"');
    expect(markup).toContain('>workspace:file:apps/web/src/components/chat/MarkdownText.tsx</a>');
    expect(markup).not.toContain('<code>workspace:file:apps/web/src/components/chat/MarkdownText.tsx</code>');
  });

  test("renders angle-bracket resource file refs as clickable file links", () => {
    const markup = renderMarkdown("Open <workspace:file:apps/web/src/components/chat/MarkdownText.tsx> next.", {
      onOpenFileInSidebar: () => {},
    });

    expect(markup).toContain('class="markdown-file-link"');
    expect(markup).toContain('>workspace:file:apps/web/src/components/chat/MarkdownText.tsx</a>');
  });

  test("renders file-only fenced code blocks as file reference links", () => {
    const markup = renderMarkdown("```\nworkspace:file:apps/web/src/components/chat/MarkdownText.tsx\napps/web/src/lib/chat-file-links.ts\n```", {
      onOpenFileInSidebar: () => {},
    });

    expect(markup).toContain('class="markdown-file-reference-block"');
    expect(markup).toContain('class="markdown-file-link"');
    expect(markup).toContain('>workspace:file:apps/web/src/components/chat/MarkdownText.tsx</a>');
    expect(markup).toContain('>apps/web/src/lib/chat-file-links.ts</a>');
    expect(markup).not.toContain('markdown-code-block');
    expect(markup).not.toContain('<code>workspace:file:apps/web/src/components/chat/MarkdownText.tsx</code>');
  });

  test("keeps mixed fenced code blocks as code", () => {
    const markup = renderMarkdown("```ts\nconst file = 'apps/web/src/lib/chat-file-links.ts';\n```", {
      onOpenFileInSidebar: () => {},
    });

    expect(markup).toContain('class="markdown-code-block"');
    expect(markup).not.toContain('markdown-file-reference-block');
  });

  test("renders bare urls as clickable links", () => {
    const markup = renderMarkdown("Open https://example.com/path?x=1, or www.openpond.ai/docs.");

    expect(markup).toContain('href="https://example.com/path?x=1"');
    expect(markup).toContain('>https://example.com/path?x=1</a>,');
    expect(markup).toContain('href="https://www.openpond.ai/docs"');
    expect(markup).toContain('>https://www.openpond.ai/docs</a>.');
  });

  test("renders numbered headings that are missing the markdown space", () => {
    const markup = renderMarkdown("##1. Draft not reappearing after send\n\nThis already works.");

    expect(markup).toContain('<h2 class="markdown-heading">1. Draft not reappearing after send</h2>');
    expect(markup).toContain('<p class="markdown-paragraph">This already works.</p>');
    expect(markup).not.toContain("##1.");
  });

  test("renders run-on fenced code without swallowing following prose", () => {
    const markup = renderMarkdown(
      '```tsx{message.content ? <div className="user-message-content">{message.content}</div> : null}\n```\n\nAfter the code block.',
    );

    expect(markup).toContain('<pre class="markdown-code-block"><code>{message.content ? &lt;div');
    expect(markup).toContain("user-message-content");
    expect(markup).toContain('</code></pre><p class="markdown-paragraph">After the code block.</p>');
    expect(markup).not.toContain("```tsx");
  });

  test("renders malformed double-backtick fenced code blocks", () => {
    const markup = renderMarkdown(
      '``ts if (action.key === "prompt") {\nconst prompt = String(nextValue);\n}\n``\n\nAfter the code block.',
    );

    expect(markup).toContain('<pre class="markdown-code-block"><code>if (action.key === &quot;prompt&quot;) {');
    expect(markup).toContain("const prompt = String(nextValue);");
    expect(markup).toContain('</code></pre><p class="markdown-paragraph">After the code block.</p>');
    expect(markup).not.toContain("``ts");
  });
});
