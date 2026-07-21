import {
  lazy,
  Suspense,
  useEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { copyToClipboard } from "../../lib/clipboard";
import { BookOpenText, Copy, FileText, Play } from "../icons";
import {
  MAKE_AGENT_TUTORIAL_LESSONS,
  MAKE_AGENT_PLAYLIST_TITLE,
  MAKE_AGENT_TUTORIAL_PLAY_ALL,
  makeAgentTutorialScript,
  makeAgentTutorialVideo,
  type MakeAgentTutorialPanelView,
  type MakeAgentTutorialVideoId,
} from "./make-agent-tutorial";

const MarkdownText = lazy(() =>
  import("../chat/MarkdownText").then((module) => ({ default: module.MarkdownText })),
);

export function MakeAgentTutorialLearningPanel({
  activeVideoId,
  autoplay,
  onResizeStart,
  onSelectVideo,
  onSetAutoplay,
  onShowLessons,
  onShowScript,
  panelView,
}: {
  activeVideoId: MakeAgentTutorialVideoId;
  autoplay: boolean;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onSelectVideo: (videoId: MakeAgentTutorialVideoId) => void;
  onSetAutoplay: (autoplay: boolean) => void;
  onShowLessons: () => void;
  onShowScript: () => void;
  panelView: MakeAgentTutorialPanelView;
}) {
  const [copied, setCopied] = useState(false);
  const activeVideo = makeAgentTutorialVideo(activeVideoId);
  const activeScript = makeAgentTutorialScript(activeVideoId);
  const scriptFileName = {
    "play-all": "how-to-make-an-agent.md",
    create: "create-an-agent.md",
    use: "use-the-agent.md",
    improve: "improve-the-agent.md",
  }[activeVideoId];

  useEffect(() => {
    if (!copied) return undefined;
    const timeout = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  function handleTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextView = event.key === "ArrowLeft" || event.key === "Home"
      ? "lessons"
      : "script";
    if (nextView === "lessons") onShowLessons();
    else onShowScript();
    document.getElementById(`make-agent-${nextView}-tab`)?.focus();
  }

  async function copyScript() {
    if (!await copyToClipboard(activeScript)) return;
    setCopied(true);
  }

  return (
    <aside
      aria-label="Agents walkthrough panel"
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
            aria-controls="make-agent-lessons-panel"
            aria-selected={panelView === "lessons"}
            className={`workspace-diff-tab ${panelView === "lessons" ? "active" : ""}`}
            id="make-agent-lessons-tab"
            onClick={onShowLessons}
            onKeyDown={handleTabKeyDown}
            role="tab"
            tabIndex={panelView === "lessons" ? 0 : -1}
            type="button"
          >
            <Play size={14} />
            <span>Lessons</span>
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

      {panelView === "lessons" ? (
        <>
          <div className="get-started-learning-panel-toolbar">
            <span>
              <strong>{MAKE_AGENT_PLAYLIST_TITLE}</strong>
              <small>{MAKE_AGENT_TUTORIAL_LESSONS.length} lessons</small>
            </span>
            <button
              aria-checked={autoplay}
              aria-label="Autoplay lessons"
              className={`get-started-learning-autoplay ${autoplay ? "active" : ""}`}
              onClick={() => onSetAutoplay(!autoplay)}
              role="switch"
              type="button"
            >
              <span>Autoplay</span>
              <i aria-hidden="true" />
            </button>
          </div>
          <div
            aria-labelledby="make-agent-lessons-tab"
            className="get-started-learning-panel-body lessons"
            id="make-agent-lessons-panel"
            role="tabpanel"
          >
            <ol>
              {MAKE_AGENT_TUTORIAL_LESSONS.map((video) => (
                <li key={video.id}>
                  <div className="get-started-learning-lesson-card">
                    <button
                      aria-current={video.videoId === activeVideoId ? "true" : undefined}
                      aria-label={`Play lesson ${video.lessonNumber}: ${video.title}`}
                      className="get-started-learning-lesson-button"
                      onClick={() => onSelectVideo(video.videoId)}
                      type="button"
                    >
                      <img alt="" decoding="async" loading="lazy" src={video.posterUrl} />
                      <span>
                        <small>{video.eyebrow} · {video.duration}</small>
                        <strong>{video.title}</strong>
                      </span>
                    </button>
                    <button
                      aria-label={`Open script for ${video.title}`}
                      className="get-started-learning-script-button app-tooltip app-tooltip-right"
                      data-tooltip="Open script"
                      onClick={() => {
                        onSelectVideo(video.videoId);
                        onShowScript();
                      }}
                      type="button"
                    >
                      <FileText size={16} />
                    </button>
                  </div>
                </li>
              ))}
            </ol>
            <footer className="get-started-learning-full-video">
              <button
                aria-current={activeVideoId === "play-all" ? "true" : undefined}
                aria-label={`Play full video: ${MAKE_AGENT_TUTORIAL_PLAY_ALL.title}`}
                onClick={() => onSelectVideo("play-all")}
                type="button"
              >
                <span className="get-started-learning-full-video-icon" aria-hidden="true">
                  <Play fill="currentColor" size={13} />
                </span>
                <span>
                  <strong>Full video</strong>
                  <small>{MAKE_AGENT_TUTORIAL_PLAY_ALL.duration} · All 3 lessons</small>
                </span>
              </button>
            </footer>
          </div>
        </>
      ) : (
        <>
          <div className="get-started-learning-panel-toolbar file">
            <span>
              <small>{activeVideo.eyebrow}</small>
              <strong>{scriptFileName}</strong>
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
                <MarkdownText content={activeScript} />
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
