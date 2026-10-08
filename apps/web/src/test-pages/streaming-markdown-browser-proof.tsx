import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { MarkdownText } from "../components/chat/MarkdownText";
import { streamingMarkdownSegments } from "../components/chat/StreamingMarkdownText";
import "../styles.css";

// Regression: catch-up and paragraph boundaries used to remount code/images,
// flashing content and discarding state even without any scroll input.
const host = document.getElementById("root")!;
const result = document.getElementById("result")!;
const root = createRoot(host);
const code = "```ts\nconst answer = 42;\n```";
const image = `![Stable image](${location.origin}/favicon-32x32.png)`;

function render(content: string, complete: boolean) {
  const segments = streamingMarkdownSegments(content, complete);
  flushSync(() => root.render(<StrictMode><MarkdownText content={content}
    finalizedContent={segments.finalized} mutableContent={segments.mutable} /></StrictMode>));
}

try {
  render(code, false);
  const originalCode = host.querySelector("pre");
  if (!originalCode) throw new Error("Code block must be visible.");
  render(code, true);
  if (host.querySelector("pre") !== originalCode) throw new Error("Catching up remounted the code block.");
  render(`${code}\n\n${image}`, false);
  if (host.querySelector("pre") !== originalCode) throw new Error("A new delta remounted earlier code.");
  const originalImage = host.querySelector("img");
  if (!originalImage) throw new Error("Image must be visible.");
  for (const complete of [true, false, true]) {
    render(`${code}\n\n${image}`, complete);
    if (host.querySelector("pre") !== originalCode || host.querySelector("img") !== originalImage)
      throw new Error("Repeated provider catch-up remounted existing blocks.");
  }
  render(`${code}\n\n${image}\n\nNext paragraph`, false);
  if (host.querySelector("pre") !== originalCode || host.querySelector("img") !== originalImage)
    throw new Error("Finalizing a paragraph remounted existing blocks.");
  result.textContent = "PASS: code and image nodes survive catch-up, resumed deltas, and paragraph finalization.";
} catch (error) {
  result.textContent = `FAIL: ${error instanceof Error ? error.message : String(error)}`;
}
