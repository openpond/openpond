import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { Approval, RuntimeEvent } from "@openpond/contracts";
import { ApprovalRequestCard } from "../components/chat/ApprovalRequestCard";
import { ConversationSurface } from "../components/chat/ConversationSurface";
import { Composer } from "../components/chat/Composer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { contextWindowStatusFromUsage } from "../lib/context-window";
import "../styles/theme.css";
import { buildChatMessages } from "../lib/chat-messages";
import "../styles.css";

// Manual boundary proof: questions submit complete answers, multi-select labels
// retain commas, and hostile option HTML cannot navigate or access the app.
const timestamp = "2026-10-14T12:00:00Z";
const base = { sessionId: "proof", turnId: "turn", timestamp, source: "provider" as const };
const questions = [
  {
    question: "Which layout should we use?",
    header: "Layout",
    options: [
      {
        label: "Compact",
        description: "Keep the transcript spacious.",
        preview:
          '<div style="padding:20px;border:1px solid;border-radius:8px"><strong>Compact layout</strong><p>Tasks and questions in one tidy card.</p></div><meta http-equiv="refresh" content="0;url=https://example.invalid"><script>parent.document.body.textContent="UNSAFE"</script>',
      },
      {
        label: "Detailed",
        description: "Show more context.",
        preview: "```text\nPlan\n  ✓ Inspect\n  → Implement\n```",
      },
    ],
  },
  {
    question: "Which checks should run?",
    header: "Checks",
    multiSelect: true,
    options: [
      { label: "Unit, integration", description: "Exercise runtime boundaries." },
      { label: "Browser", description: "Inspect rendered UI." },
    ],
  },
];
function App() {
  const [mode, setMode] = useState<"progress" | "questions" | "plan">("progress");
  const [completed, setCompleted] = useState(false);
  const [finished, setFinished] = useState(false);
  const [nextRequest, setNextRequest] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [queued, setQueued] = useState(false);
  const [normalResponseLines, setNormalResponseLines] = useState<number | null>(null);
  const [submissionVersion, setSubmissionVersion] = useState(0);
  const [receipt, setReceipt] = useState("");
  const events: RuntimeEvent[] = [
    {
      ...base,
      id: "request",
      name: "turn.started",
      args: { prompt: "Implement the Claude cards" },
    },
    {
      ...base,
      id: "progress",
      name: "tool.completed",
      action: "update_plan",
      status: "completed",
      data: {
        plan: [
          { id: "1", content: "Inspect documented events", status: "completed" },
          {
            id: "2",
            content: "Implement the cards",
            activeForm: "Implementing the cards",
            status: completed || finished ? "completed" : "in_progress",
          },
          { id: "3", content: "Review the interface", status: finished ? "completed" : completed ? "in_progress" : "pending" },
        ],
      },
    },
    ...Array.from({ length: 12 }, (_, index): RuntimeEvent => ({
      ...base,
      id: `text-${index}`,
      name: "assistant.delta",
      output: `Conversation update ${index + 1}. The task checklist remains connected to the composer while this transcript scrolls.\n\n`,
      data: { nativeMessageId: `commentary-${index}`, phase: "commentary" },
    })),
    {
      ...base,
      id: "notification",
      name: "turn.started",
      args: {
        prompt:
          "<task-notification><task-id>background-1</task-id><status>completed</status><summary>Background checks finished.</summary><output-file>/tmp/checks.output</output-file></task-notification>",
      },
      data: { retainedHistory: true, nativeProvider: "claude-code" },
    },
  ];
  if (finished) events.push(
    { ...base, id: "answer", name: "assistant.delta", output: "The interface is ready.", data: { nativeMessageId: "answer", phase: "final_answer", nativeMessageSnapshot: true } },
    { ...base, id: "finished", name: "turn.completed" },
  );
  if (nextRequest) events.push({ ...base, turnId: "next", id: "next-request", name: "turn.started", args: { prompt: "Start a fresh task" } });
  const normal = normalResponseLines !== null;
  const displayedEvents = normal ? events.filter(event => event.action !== "update_plan" && event.id !== "notification") : events;
  if (normal) displayedEvents.push(
    { ...base, id: "normal-request", turnId: "normal", name: "turn.started", args: { prompt: "Check normal chat scrolling while a response streams." } },
    { ...base, id: "normal-answer", turnId: "normal", name: "assistant.delta",
      output: Array.from({ length: normalResponseLines }, (_, index) => `Response update ${index + 1}: the newest text should stay above the composer as this response grows.`).join("\n\n"),
      data: { nativeMessageId: "normal-answer", phase: "commentary" } },
  );
  const messages = buildChatMessages(displayedEvents);
  const running = !finished || nextRequest;
  const approval: Approval | null =
    mode === "progress"
      ? null
      : {
          id: mode,
          sessionId: "proof",
          turnId: "turn",
          providerRequestId: "native-agent:proof",
          status: "pending",
          createdAt: timestamp,
          kind: mode === "questions" ? "user_input" : "permissions",
          title: mode === "questions" ? "AskUserQuestion" : "ExitPlanMode",
          detail: JSON.stringify({
            options: [
              { kind: "allow_once", name: "Allow" },
              { kind: "reject_once", name: "Deny" },
            ],
            ...(mode === "questions"
              ? { questions }
              : {
                  toolCall: {
                    toolName: "ExitPlanMode",
                    rawInput: {
                      plan:
                        "# Proposed plan\n\n1. Read structured Claude events.\n2. Show questions above the composer.\n3. Keep the task list current.\n\n" +
                        "Review the implementation and verify the runtime boundary.\n\n".repeat(15),
                    },
                  },
                }),
          }),
        };
  return (
    <div className="app-shell" style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <nav style={{ display: "flex", flexShrink: 0, flexWrap: "wrap", gap: 12, padding: 16 }}>
        <button onClick={() => { setMode("progress"); setNormalResponseLines(null); }}>Progress</button>
        <button onClick={() => { setNormalResponseLines(1); setSubmissionVersion(value => value + 1); setMode("progress"); setQueued(false); }}>Normal response</button>
        <button disabled={normalResponseLines === null} onClick={() => setNormalResponseLines(value => (value ?? 0) + 8)}>Stream more text</button>
        <button onClick={() => setMode("questions")}>Questions</button>
        <button onClick={() => setMode("plan")}>Plan review</button>
        <button onClick={() => setCompleted((value) => !value)}>Update progress</button>
        <button onClick={() => setFinished(true)}>Complete turn</button>
        <button onClick={() => { setFinished(true); setNextRequest(true); }}>New request</button>
        <button onClick={() => setQueued(value => !value)}>Toggle steer</button>
        <button onClick={() => { setFinished(false); setNextRequest(false); setCompleted(false); }}>Reset</button>
        <button onClick={() => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === "light" ? "dark" : "light"; }}>Toggle theme</button>
      </nav>
      <main style={{ flex: 1, minHeight: 0, width: "100%", maxWidth: 900, margin: "0 auto", display: "grid", gridTemplateRows: "minmax(0, 1fr) auto" }}>
        <ConversationSurface scroll={{ browserConversationId: "proof", chatSubmissionVersion: submissionVersion,
          chatMessages: messages, chatHistoryHasMore: false, chatHistoryLoading: false,
          pendingApproval: approval, showChatThread: true, showThinkingIndicator: false, turnRunning: running, view: "chat" }}
          hasApproval={Boolean(approval)}
          thread={{ connection: null }}
          composerPrefix={<ApprovalRequestCard connection={null} showToast={message => { setReceipt(message); return 1; }} approval={approval} onResolve={async (_id, decision, answers) => {
            setReceipt(JSON.stringify({ decision, answers })); setMode("progress");
          }} />}
          composer={<Composer key={queued ? "steer" : "plain"} mode="dock" prompt={prompt} onPromptChange={setPrompt}
            busy={false} running={running} connection={null} provider="claude-code" model="default"
            contextWindowStatus={contextWindowStatusFromUsage({ provider: "claude-code", snapshot: null })}
            enableResourceContext={false} showProjectFooter={false}
            projectTarget={{ value: "", label: "Local project", detail: "", options: [], busy: false }}
            workspaceTarget={{ value: "local", label: "Local", detail: "", options: [], busy: false,
              action: { value: "local", label: "Local", detail: "", disabled: false } }}
            codexPermissionMode="full-access" codexReasoningEffort="high" openPondCommandAccessMode="full-access"
            onProviderChange={() => {}} onProjectTargetChange={() => {}} onWorkspaceTargetChange={() => {}}
            onModelChange={() => {}} onCodexPermissionModeChange={() => {}} onCodexReasoningEffortChange={() => {}}
            onOpenPondCommandAccessModeChange={() => {}} showToast={message => { setReceipt(message); return 1; }}
            onSubmit={async () => true} onStop={() => setFinished(true)}
            initialSteerDrafts={queued ? [{ id: "steer", createdAt: timestamp, updatedAt: timestamp, prompt: "Focus on the current task first" }] : []}
          />}
        />
        <output aria-label="Proof receipt">{receipt}</output>
      </main>
    </div>
  );
}
const root = createRoot(document.getElementById("root")!);
root.render(<QueryClientProvider client={new QueryClient()}><App /></QueryClientProvider>);
import.meta.hot?.dispose(() => root.unmount());
