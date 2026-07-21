import {
  lazy,
  Suspense,
  useEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { copyToClipboard } from "../../lib/clipboard";
import { BookOpenText, Copy, FileText, ListFilter } from "../icons";
import {
  MAKE_AGENT_TUTORIAL,
  MAKE_AGENT_TUTORIAL_CHAPTERS,
  MAKE_AGENT_TUTORIAL_SCRIPT,
  type MakeAgentTutorialPanelView,
} from "./make-agent-tutorial";

const MarkdownText = lazy(() =>
  import("../chat/MarkdownText").then((module) => ({ default: module.MarkdownText })),
);

export function MakeAgentTutorialLearningPanel({
  onResizeStart,
  onShowScript,
  onShowSteps,
  panelView,
}: {
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onShowScript: () => void;
  onShowSteps: () => void;
  panelView: MakeAgentTutorialPanelView;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timeout = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  function handleTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextView = event.key === "ArrowLeft" || event.key === "Home"
      ? "steps"
      : "script";
    if (nextView === "steps") onShowSteps();
    else onShowScript();
    document.getElementById(`make-agent-${nextView}-tab`)?.focus();
  }

  async function copyScript() {
    if (!await copyToClipboard(MAKE_AGENT_TUTORIAL_SCRIPT)) return;
    setCopied(true);
  }

  return (
    <aside
      aria-label="How to make an agent walkthrough panel"
      className={`workspace-diff-panel get-started-learning-panel show-${panelView}`}
    >
      <div
        aria-label="Resize walkthrough panel"
        aria-orientation="vertical"
        className="workspace-diff-resize-handle"
        onPointerDown={onResizeStart}
        role="separator"
      />

      <div className="workspace-diff-topbar get-started-learning-panel-tabs">
        <div aria-label="Walkthrough panel views" className="workspace-diff-tabs" role="tablist">
          <button
            aria-controls="make-agent-steps-panel"
            aria-selected={panelView === "steps"}
            className={`workspace-diff-tab ${panelView === "steps" ? "active" : ""}`}
            id="make-agent-steps-tab"
            onClick={onShowSteps}
            onKeyDown={handleTabKeyDown}
            role="tab"
            tabIndex={panelView === "steps" ? 0 : -1}
            type="button"
          >
            <ListFilter size={14} />
            <span>Steps</span>
          </button>
          <button
            aria-controls="make-agent-script-panel"
            aria-selected={panelView === "script"}
            className={`workspace-diff-tab ${panelView === "script" ? "active" : ""}`}
            id="make-agent-script-tab"
            onClick={onShowScript}
            onKeyDown={handleTabKeyDown}
            role="tab"
            tabIndex={panelView === "script" ? 0 : -1}
            type="button"
          >
            <FileText size={14} />
            <span>Script</span>
          </button>
        </div>
      </div>

      {panelView === "steps" ? (
        <>
          <div className="get-started-learning-panel-toolbar">
            <span>
              <strong>{MAKE_AGENT_TUTORIAL.title}</strong>
              <small>{MAKE_AGENT_TUTORIAL_CHAPTERS.length} chapters · captions available</small>
            </span>
          </div>
          <div
            aria-labelledby="make-agent-steps-tab"
            className="get-started-learning-panel-body make-agent-steps"
            id="make-agent-steps-panel"
            role="tabpanel"
          >
            {MAKE_AGENT_TUTORIAL_CHAPTERS.map((chapter) => (
              <section key={chapter.id}>
                <h3>{chapter.label}</h3>
                <ol>
                  {chapter.steps.map((step, index) => (
                    <li key={step.id}>
                      <span>{index + 1}</span>
                      <div>
                        <strong>{step.label}</strong>
                        <p>{step.narration}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="get-started-learning-panel-toolbar file">
            <span>
              <small>Walkthrough</small>
              <strong>how-to-make-an-agent.md</strong>
            </span>
            <button
              aria-label={copied ? "Script copied" : "Copy walkthrough script"}
              className="diff-icon-button"
              onClick={() => void copyScript()}
              title={copied ? "Copied" : "Copy script"}
              type="button"
            >
              <Copy size={14} />
            </button>
          </div>
          <div
            aria-labelledby="make-agent-script-tab"
            className="get-started-learning-panel-body script"
            id="make-agent-script-panel"
            role="tabpanel"
          >
            <div className="workspace-markdown-preview">
              <Suspense fallback={<ScriptLoadingState />}>
                <MarkdownText content={MAKE_AGENT_TUTORIAL_SCRIPT} />
              </Suspense>
            </div>
          </div>
        </>
      )}
    </aside>
  );
}

function ScriptLoadingState() {
  return (
    <div className="get-started-script-status">
      <BookOpenText size={18} />
      <span>Opening walkthrough script…</span>
    </div>
  );
}
