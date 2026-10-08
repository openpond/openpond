import { expect, test, vi } from "vitest";
import { observeChatScrollIntent } from "../apps/web/src/components/app-shell/chat-scroll-intent";

// Upward input must stop streaming follow before layout and scroll events can
// pull the reader back down; departing chats must release their listeners.
test("upward wheel and touch input cancel following synchronously and release on detach", () => {
  const element = new EventTarget();
  const stopFollowing = vi.fn();
  const release = observeChatScrollIntent(element as HTMLElement, stopFollowing);
  const dispatch = (type: string, values: object) => {
    element.dispatchEvent(Object.assign(new Event(type), values));
  };
  dispatch("wheel", { deltaY: 20 });
  dispatch("wheel", { deltaY: 0 });
  expect(stopFollowing).not.toHaveBeenCalled();
  dispatch("wheel", { deltaY: -20 });
  expect(stopFollowing).toHaveBeenCalledTimes(1);
  dispatch("touchstart", { touches: [{ clientY: 100 }] });
  dispatch("touchmove", { touches: [{ clientY: 80 }] });
  expect(stopFollowing).toHaveBeenCalledTimes(1);
  dispatch("touchmove", { touches: [{ clientY: 120 }] });
  expect(stopFollowing).toHaveBeenCalledTimes(2);
  dispatch("keydown", { key: "PageUp" });
  dispatch("keydown", { key: "Home" });
  dispatch("keydown", { key: " ", shiftKey: true });
  expect(stopFollowing).toHaveBeenCalledTimes(5);
  dispatch("keydown", { key: "ArrowDown" });
  dispatch("keydown", { key: " ", shiftKey: false });
  expect(stopFollowing).toHaveBeenCalledTimes(5);
  Object.assign(element, { closest: () => ({ tagName: "INPUT" }) });
  dispatch("keydown", { key: "ArrowUp" });
  expect(stopFollowing).toHaveBeenCalledTimes(5);
  Object.assign(element, { closest: () => null });
  Object.assign(element, {
    clientLeft: 0,
    clientWidth: 491,
    getBoundingClientRect: () => ({ left: 10, right: 510 }),
  });
  dispatch("pointerdown", { clientX: 200 });
  expect(stopFollowing).toHaveBeenCalledTimes(5);
  dispatch("pointerdown", { clientX: 505 });
  expect(stopFollowing).toHaveBeenCalledTimes(6);
  release();
  dispatch("wheel", { deltaY: -20 });
  dispatch("touchstart", { touches: [{ clientY: 100 }] });
  dispatch("touchmove", { touches: [{ clientY: 120 }] });
  dispatch("keydown", { key: "PageUp" });
  dispatch("pointerdown", { clientX: 505 });
  expect(stopFollowing).toHaveBeenCalledTimes(6);
});
