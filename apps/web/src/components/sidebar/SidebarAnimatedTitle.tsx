import { useEffect, useRef, useState } from "react";

const TITLE_CHARACTER_INTERVAL_MS = 24;

export function SidebarAnimatedTitle({ title }: { title: string }) {
  const previousTitleRef = useRef(title);
  const [visibleTitle, setVisibleTitle] = useState(title);

  useEffect(() => {
    const previousTitle = previousTitleRef.current;
    previousTitleRef.current = title;

    if (!title) {
      setVisibleTitle("");
      return;
    }
    if (previousTitle || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setVisibleTitle(title);
      return;
    }

    const characters = Array.from(title);
    let visibleCharacterCount = 0;
    setVisibleTitle("");
    const timer = window.setInterval(() => {
      visibleCharacterCount += 1;
      setVisibleTitle(characters.slice(0, visibleCharacterCount).join(""));
      if (visibleCharacterCount >= characters.length) window.clearInterval(timer);
    }, TITLE_CHARACTER_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [title]);

  return (
    <span
      className="sidebar-task-title-text"
      aria-label={title || "New task"}
    >
      {visibleTitle || "New task"}
    </span>
  );
}
