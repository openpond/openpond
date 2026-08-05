import type { ComponentProps } from "react";
import { useSmoothStreamingText } from "../../hooks/useSmoothStreamingText";
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

  return <MarkdownText {...props} content={visibleContent} />;
}
