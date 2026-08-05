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

  return <MarkdownText {...props} content={renderedContent} />;
}
