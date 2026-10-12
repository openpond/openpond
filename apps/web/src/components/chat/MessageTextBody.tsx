import type { ComponentProps, ReactNode } from "react";
import { useSmoothStreamingText } from "../../hooks/useSmoothStreamingText";
import { MarkdownText } from "./MarkdownText";
import { StreamingMarkdownText } from "./StreamingMarkdownText";

type MessageTextBodyProps = Omit<ComponentProps<typeof MarkdownText>, "content"> & {
  content?: string;
  reasoningContent?: string;
  animateInitialContent: boolean;
  children: ReactNode;
  footer: ReactNode;
};

/** Completion metadata must wait for both the provider and the visible reveal. */
export function MessageTextBody({
  content = "",
  reasoningContent = "",
  animateInitialContent,
  children,
  footer,
  ...markdownProps
}: MessageTextBodyProps) {
  const visibleContent = useSmoothStreamingText(content, animateInitialContent);
  const visibleReasoning = useSmoothStreamingText(reasoningContent, animateInitialContent);
  const revealed = visibleContent === content && visibleReasoning === reasoningContent;

  return <>
    {reasoningContent ? <div className="assistant-message">
      <StreamingMarkdownText {...markdownProps} content={reasoningContent} visibleContent={visibleReasoning} />
    </div> : null}
    {content ? <div className="assistant-message">
      <StreamingMarkdownText {...markdownProps} content={content} visibleContent={visibleContent} />
    </div> : null}
    {children}
    {revealed ? footer : null}
  </>;
}
