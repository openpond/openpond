import type { Dispatch, KeyboardEvent, SetStateAction } from "react";

type ComposerMenuKeyEvent = Pick<KeyboardEvent, "key" | "preventDefault">;

interface ComposerMenuKeyboardOptions<T> {
  open: boolean;
  matches: readonly T[];
  index: number;
  setIndex: Dispatch<SetStateAction<number>>;
  select: (item: T) => void;
  dismiss: () => void;
}

const addMenuKeys = new Set(["ArrowDown", "ArrowUp", "Home", "End", "Enter", "Escape"]);

export function consumeComposerAddMenuKey(event: ComposerMenuKeyEvent, open: boolean): boolean {
  if (!open || !addMenuKeys.has(event.key)) return false;
  event.preventDefault();
  return true;
}

/** Returns whether an open completion menu consumed the composer key. */
export function handleComposerMenuKey<T>(
  event: ComposerMenuKeyEvent,
  { open, matches, index, setIndex, select, dismiss }: ComposerMenuKeyboardOptions<T>,
): boolean {
  if (!open) return false;
  if (matches.length > 0) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setIndex((current) => (current + direction + matches.length) % matches.length);
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      select(matches[index] ?? matches[0]!);
      return true;
    }
  }
  if (event.key === "Escape") {
    event.preventDefault();
    dismiss();
    return true;
  }
  return false;
}
