import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { Approval, RuntimeEvent } from "@openpond/contracts";
import { ApprovalRequestCard } from "../components/chat/ApprovalRequestCard";
import { MainChatThread } from "../components/app-shell/MainChatThread";
import { buildChatMessages } from "../lib/chat-messages";
import { buildChatTimelineRows } from "../lib/chat-timeline-rows";
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
            status: completed ? "completed" : "in_progress",
          },
          { id: "3", content: "Review the interface", status: "pending" },
        ],
      },
    },
    ...Array.from({ length: 12 }, (_, index): RuntimeEvent => ({
      ...base,
      id: `text-${index}`,
      name: "assistant.delta",
      output: `Conversation update ${index + 1}. The pinned planner remains visible while this transcript scrolls.\n\n`,
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
    <div className="app-shell" style={{ height: "100vh", display: "block" }}>
      <nav style={{ display: "flex", gap: 12, padding: 16 }}>
        <button onClick={() => setMode("progress")}>Progress</button>
        <button onClick={() => setMode("questions")}>Questions</button>
        <button onClick={() => setMode("plan")}>Plan review</button>
        <button onClick={() => setCompleted((value) => !value)}>Update progress</button>
      </nav>
      <main
        className={`chat-column ${approval ? "has-approval" : ""}`}
        style={{
          height: "calc(100vh - 64px)",
          maxWidth: 900,
          margin: "auto",
          position: "relative",
        }}
      >
        <MainChatThread
          accountBaseUrl={null}
          activeWorkspaceAppId={null}
          billingOrganizationSlug={null}
          billingTeamId={null}
          connection={null}
          conversationKey="proof"
          creation={null}
          onOpenBrowserLink={undefined}
          onOpenAttachmentInSidebar={undefined}
          onOpenFileInSidebar={undefined}
          onOpenProfileSettings={undefined}
          onResolveUserQuestion={undefined}
          onOpenSession={undefined}
          onScroll={() => {}}
          rows={buildChatTimelineRows(buildChatMessages(events))}
          sessionId={null}
          turnRunning={true}
          userAttachmentDisplay="full"
          threadRef={null}
          workspaceRootPath={null}
        />
        <div className="composer-stack dock">
          <ApprovalRequestCard
            approval={approval}
            onResolve={async (_id, decision, answers) => {
              setReceipt(JSON.stringify({ decision, answers }));
              setMode("progress");
            }}
          />
          <div className="composer" style={{ minHeight: 100, padding: 16 }}>
            Message composer<output style={{ display: "block" }}>{receipt}</output>
          </div>
        </div>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
