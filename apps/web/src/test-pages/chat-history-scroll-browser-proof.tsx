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
let submission = 0;
let running = false;
let streamingFixture = false;
let answerHeight = 40;

function Harness() {
  scroll = useMainPaneChatScroll({
    browserConversationId: conversation,
    chatSubmissionVersion: submission,
    chatHistoryHasMore: hasMore,
    chatHistoryLoading: loading,
    chatMessages: messages,
    pendingApproval: null,
    showChatThread: true,
    showThinkingIndicator: false,
    turnRunning: running,
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
    style={{ height: 300, boxSizing: "border-box", overflowY: "auto", overflowAnchor: "auto",
      paddingBottom: "calc(40px + var(--chat-sent-message-space, 0px))" }}>
    {scroll.chatTimelineRows.map((row) => <article key={row.id}
      data-chat-user-message={row.type === "message" && row.message.role === "user" ? "true" : undefined}
      style={{ height: streamingFixture && row.id === "message:request" ? 40 : streamingFixture && row.id === "message:answer" ? answerHeight : 400 }}>
      {row.type === "message" ? row.message.content : row.id}</article>)}
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

  // Real layout and native scroll events are needed to catch the sent-message
  // spacer trapping a reader who returns to a response while it still streams.
  streamingFixture = true;
  conversation = "streaming";
  messages = [message("history")];
  render();
  await frames();
  messages = [...messages, message("request"), {
    ...message("answer"), role: "assistant", content: "Streaming response",
  }];
  submission++;
  running = true;
  render();
  await frames(40);
  check(Number.parseFloat(thread().style.getPropertyValue("--chat-sent-message-space")) > 0,
    "Fixture must reserve space beneath the sent message.");
  const requestTop = thread().scrollTop;
  answerHeight += 20;
  render();
  await frames();
  check(Math.abs(thread().scrollTop - requestTop) < 1,
    "Streaming moved the sent request before the reader took control.");
  thread().dispatchEvent(new WheelEvent("wheel", { deltaY: -150 }));
  thread().scrollTop -= 150;
  await frames(2);
  const readingTop = thread().scrollTop;
  answerHeight += 20;
  render();
  await frames();
  check(Math.abs(thread().scrollTop - readingTop) < 1, "Streaming interrupted reading older messages.");
  thread().dispatchEvent(new WheelEvent("wheel", { deltaY: 1000 }));
  thread().scrollTop = thread().scrollHeight;
  await frames();
  check(!thread().style.getPropertyValue("--chat-sent-message-space"),
    "Returning to the bottom left empty sent-message space beneath the response.");
  check(!scroll.showScrollToBottomButton, "Returning to the bottom did not resume following.");
  answerHeight += 350;
  render();
  await frames(40);
  check(thread().scrollHeight - thread().clientHeight - thread().scrollTop < 1,
    "Returning to the bottom did not follow subsequent streamed content.");

  // Downward intent must survive content growing before the native scroll
  // event, including a gesture at the bottom that produces no scroll event.
  for (const growth of [20, 250, 0]) {
    thread().dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
    thread().scrollTop -= 100;
    await frames(2);
    thread().scrollTop = thread().scrollHeight;
    thread().dispatchEvent(new WheelEvent("wheel", { deltaY: 1000 }));
    answerHeight += growth;
    render();
    await frames(40);
    answerHeight += 100;
    render();
    await frames(40);
    check(thread().scrollHeight - thread().clientHeight - thread().scrollTop < 1,
      "Concurrent streaming layout stranded a reader returning to the bottom.");
  }
  thread().dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
  thread().scrollTop -= 100;
  await frames(2);
  thread().scrollTop = thread().scrollHeight;
  thread().dispatchEvent(new WheelEvent("wheel", { deltaY: 1000 }));
  thread().dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
  thread().scrollTop -= 100;
  const reversedTop = thread().scrollTop;
  answerHeight += 100;
  render();
  await frames(40);
  check(Math.abs(thread().scrollTop - reversedTop) < 1,
    "Reversing an unfinished downward gesture resumed following against the reader's intent.");
  scroll.jumpToLatestChatMessage();
  await frames(40);
  answerHeight += 100;
  render();
  await frames(40);
  check(thread().scrollHeight - thread().clientHeight - thread().scrollTop < 1,
    "Jumping to latest did not keep following streamed content.");
  result.textContent = "PASS: history pagination preserves reading position; returning to a streaming response releases reserved space and resumes following through concurrent layout changes.";
}
void run().catch((error) => { result.textContent = `FAIL: ${error instanceof Error ? error.message : String(error)}`; });
