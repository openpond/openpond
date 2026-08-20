import type { ComponentProps } from "react";
import { useSmoothStreamingText } from "../../hooks/useSmoothStreamingText";
import { renderableStreamingMarkdown } from "./MarkdownBlocks";
import { MarkdownText } from "./MarkdownText";

type StreamingMarkdownTextProps = ComponentProps<typeof MarkdownText> & {
  animateInitialContent?: boolean;
};

export function StreamingMarkdownText({
  animateInitialContent = false,
  content,
  ...props
}: StreamingMarkdownTextProps) {
  const visibleContent = useSmoothStreamingText(
    content,
    animateInitialContent
  );
  const renderedContent = renderableStreamingMarkdown(
    visibleContent,
    visibleContent.length === content.length
  );
  const segments = streamingMarkdownSegments(
    renderedContent,
    visibleContent.length === content.length,
  );

  return (
    <MarkdownText
      {...props}
      content={renderedContent}
      finalizedContent={segments.finalized}
      mutableContent={segments.mutable}
    />
  );
}

export function streamingMarkdownSegments(
  content: string,
  complete: boolean,
): { finalized: string; mutable: string } {
  if (complete || !content) return { finalized: content, mutable: "" };
  const lines = content.split("\n");
  let fenced = false;
  let offset = 0;
  let finalizedEnd = 0;
  for (let index = 0; index < lines.length - 1; index += 1) {
    const line = lines[index] ?? "";
    if (/^\s*```/.test(line)) fenced = !fenced;
    offset += line.length + 1;
    if (!fenced && line.trim() === "") finalizedEnd = offset;
  }
  return {
    finalized: content.slice(0, finalizedEnd),
    mutable: content.slice(finalizedEnd),
  };
}
