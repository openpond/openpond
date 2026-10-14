import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useMainPaneChatScroll } from "../components/app-shell/useMainPaneChatScroll";
import type { ChatMessage } from "../lib/app-models";

// A reader reaching the top during a request must reach earlier messages even
// through pages of tools that add no visible rows. Also guard request failures
// and completions belonging to a chat that the reader has already left.
const root = createRoot(document.getElementById("root")!);
const result = document.getElementById("result")!;
const message = (id: string): ChatMessage => ({
  id, role: "user", content: id, timestamp: "2026-10-13T12:00:00Z",
});
let messages = [message("Recent message"), message("Latest message")];
let conversation = "first";
let loading = false;
let hasMore = true;
let calls = 0;
let inFlight = 0;
let maxInFlight = 0;
let finish: (loaded: boolean) => void = () => {};
let scroll: ReturnType<typeof useMainPaneChatScroll>;

function Harness() {
  scroll = useMainPaneChatScroll({
    browserConversationId: conversation,
    chatSubmissionVersion: 0,
    chatHistoryHasMore: hasMore,
    chatHistoryLoading: loading,
    chatMessages: messages,
    pendingApproval: null,
    showChatThread: true,
    showThinkingIndicator: false,
    turnRunning: false,
    view: "chat",
    onLoadMoreChatHistory: () => {
      calls++;
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      return new Promise<boolean>((resolve) => {
        finish = (loaded) => { inFlight--; resolve(loaded); };
      });
    },
  });
  return <section aria-label="Conversation" ref={scroll.chatThreadRef}
    onScroll={(event) => scroll.handleChatScroll(event.currentTarget)}
    style={{ height: 300, overflowY: "auto", overflowAnchor: "none" }}>
    {scroll.chatTimelineRows.map((row) => <article key={row.id} data-chat-user-message="true"
      style={{ height: 400 }}>{row.type === "message" ? row.message.content : row.id}</article>)}
  </section>;
}

function render() { flushSync(() => root.render(<StrictMode><Harness /></StrictMode>)); }
async function frames(count = 15) {
  for (let index = 0; index < count; index++) await new Promise(requestAnimationFrame);
}
function check(condition: boolean, failure: string) { if (!condition) throw new Error(failure); }
function thread() { return document.querySelector<HTMLElement>("section")!; }
function reachTop() {
  thread().dispatchEvent(new WheelEvent("wheel", { deltaY: -500 }));
  thread().scrollTop = 0;
  scroll.handleChatScroll(thread());
}
async function run() {
  render();
  await frames();
  check(thread().scrollHeight > thread().clientHeight + 120, "Fixture must contain a tall transcript.");
  loading = true;
  render();
  await frames(2);
  reachTop();
  loading = false;
  render();
  await frames();
  check(calls === 1, "Reaching the top during a request stranded the reader when loading finished.");

  // This page contains only tool events: the rendered transcript is unchanged.
  finish(true);
  await frames();
  check(calls === 2, "A tool-only page stranded the reader at the top.");
  messages = [message("Earlier message"), ...messages];
  render();
  finish(true);
  await frames();
  check(thread().firstElementChild?.textContent === "Earlier message", "Older message never appeared.");
  check(Math.abs(thread().scrollTop - 400) < 1, "Loading older messages moved the reader's visible row.");
  check(calls === 2 && maxInFlight === 1, "Pagination duplicated a request or loaded beyond the visible boundary.");

  reachTop();
  await frames();
  check(calls === 3, "Returning to the top did not request the next page.");
  finish(false);
  await frames();
  render();
  await frames();
  check(calls === 3, "A failed page caused an automatic retry loop.");
  thread().scrollTop = 200;
  scroll.handleChatScroll(thread());
  reachTop();
  await frames();
  check(calls === 4, "A failed page could not be retried by scrolling.");

  conversation = "second";
  messages = [message("Other chat")];
  hasMore = false;
  render();
  await frames();
  const otherTop = thread().scrollTop;
  finish(true);
  await frames();
  check(thread().scrollTop === otherTop && calls === 4, "An old chat request changed the new chat viewport.");
  result.textContent = "PASS: loading resumes at the top, crosses tool-only pages, preserves the visible row, pauses after failure, allows retry, and ignores old chat completions.";
}
void run().catch((error) => { result.textContent = `FAIL: ${error instanceof Error ? error.message : String(error)}`; });
