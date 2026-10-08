import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "../icons";

/** User and task handoff bubbles share a five-visible-line preview. */
export function UserMessageContent({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const contentId = useId();
  useEffect(() => {
    const element = body.current;
    if (!element) return;
    const measure = () => {
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
      setOverflows(element.scrollHeight > Math.ceil(lineHeight * 5) + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [content, expanded]);
  return (
    <div className="user-message-content-wrap">
      <div ref={body} id={contentId}
        className={`user-message-content ${expanded ? "" : "collapsed"}`}>
        {content}
      </div>
      {overflows ? (
        <button type="button" className="user-message-show-more"
          aria-expanded={expanded} aria-controls={contentId}
          onClick={() => setExpanded(value => !value)}>
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          <span>{expanded ? "Show less" : "Show more"}</span>
        </button>
      ) : null}
    </div>
  );
}
