import {
  lazy,
  Suspense,
  useEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { copyToClipboard } from "../../lib/clipboard";
import { BookOpenText, Copy, FileText, Play, RotateCw } from "../icons";
import {
  POST_TRAINING_LESSONS,
  POST_TRAINING_SERIES_TITLE,
  type PostTrainingPanelView,
} from "./post-training-lessons";
import { PostTrainingStatusPill } from "./PostTrainingStatusPill";
import {
  postTrainingProgressPercent,
  usePostTrainingProgress,
} from "./post-training-progress";

const MarkdownText = lazy(() =>
  import("../chat/MarkdownText").then((module) => ({ default: module.MarkdownText })),
);

const scriptRequests = new Map<string, Promise<string>>();

function requestScript(url: string): Promise<string> {
  const existing = scriptRequests.get(url);
  if (existing) return existing;

  const request = fetch(url).then((response) => {
    if (!response.ok) {
      throw new Error(`Could not open script (${response.status})`);
    }
    return response.text();
  }).catch((error: unknown) => {
    scriptRequests.delete(url);
    throw error;
  });
  scriptRequests.set(url, request);
  return request;
}

export function PostTrainingLearningPanel({
  activeLessonIndex,
  autoplay,
  onResizeStart,
  onOpenScript,
  onSelectLesson,
  onSetAutoplay,
  onShowLessons,
  panelView,
  scriptLessonIndex,
}: {
  activeLessonIndex: number;
  autoplay: boolean;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onOpenScript: (lessonIndex: number) => void;
  onSelectLesson: (index: number) => void;
  onSetAutoplay: (autoplay: boolean) => void;
  onShowLessons: () => void;
  panelView: PostTrainingPanelView;
  scriptLessonIndex: number | null;
}) {
  const scriptLesson = scriptLessonIndex === null
    ? null
    : POST_TRAINING_LESSONS[scriptLessonIndex] ?? null;

  function handleTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (!scriptLesson) return;
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextView = event.key === "ArrowLeft" || event.key === "Home"
      ? "lessons"
      : "script";
    if (nextView === "lessons") onShowLessons();
    else onOpenScript(scriptLessonIndex!);
    document.getElementById(`post-training-${nextView}-tab`)?.focus();
  }

  return (
    <aside
      aria-label="Post-training learning panel"
      className={`workspace-diff-panel get-started-learning-panel show-${panelView}`}
    >
      <div
        aria-label="Resize learning panel"
        aria-orientation="vertical"
        className="workspace-diff-resize-handle"
        onPointerDown={onResizeStart}
        role="separator"
      />

      <div className="workspace-diff-topbar get-started-learning-panel-tabs">
        <div aria-label="Learning panel views" className="workspace-diff-tabs" role="tablist">
          <button
            aria-controls="post-training-lessons-panel"
            aria-selected={panelView === "lessons"}
            className={`workspace-diff-tab ${panelView === "lessons" ? "active" : ""}`}
            id="post-training-lessons-tab"
            onClick={onShowLessons}
            onKeyDown={handleTabKeyDown}
            role="tab"
            tabIndex={panelView === "lessons" ? 0 : -1}
            type="button"
          >
            <Play size={14} />
            <span>Lessons</span>
          </button>
          {scriptLesson ? (
            <button
              aria-controls="post-training-script-panel"
              aria-selected={panelView === "script"}
              className={`workspace-diff-tab ${panelView === "script" ? "active" : ""}`}
              id="post-training-script-tab"
              onClick={() => onOpenScript(scriptLessonIndex!)}
              onKeyDown={handleTabKeyDown}
              role="tab"
              tabIndex={panelView === "script" ? 0 : -1}
              type="button"
            >
              <FileText size={14} />
              <span>{scriptLesson.script?.fileName}</span>
            </button>
          ) : null}
        </div>
      </div>

      {panelView === "lessons" ? (
        <>
          <div className="get-started-learning-panel-toolbar">
            <span>
              <span className="get-started-learning-toolbar-title">
                <strong>{POST_TRAINING_SERIES_TITLE}</strong>
                <PostTrainingStatusPill />
              </span>
              <small>{POST_TRAINING_LESSONS.length} lessons</small>
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
            aria-labelledby="post-training-lessons-tab"
            className="get-started-learning-panel-body lessons"
            id="post-training-lessons-panel"
            role="tabpanel"
          >
            <PostTrainingLessonList
              activeLessonIndex={activeLessonIndex}
              onOpenScript={onOpenScript}
              onSelectLesson={onSelectLesson}
            />
          </div>
        </>
      ) : (
        scriptLesson ? (
          <PostTrainingScriptFile key={scriptLesson.script?.url} lessonIndex={scriptLessonIndex!} />
        ) : null
      )}
    </aside>
  );
}

function PostTrainingLessonList({
  activeLessonIndex,
  onOpenScript,
  onSelectLesson,
}: {
  activeLessonIndex: number;
  onOpenScript: (lessonIndex: number) => void;
  onSelectLesson: (index: number) => void;
}) {
  const progress = usePostTrainingProgress();

  return (
    <ol>
      {POST_TRAINING_LESSONS.map((lesson, index) => {
        const isActive = index === activeLessonIndex;
        const lessonProgress = progress[lesson.id];
        const percent = postTrainingProgressPercent(lessonProgress);
        const progressLabel = lessonProgress?.completed
          ? "Complete"
          : `${percent}% watched`;
        return (
          <li key={lesson.id}>
            <div className="get-started-learning-lesson-card">
              <button
                className="get-started-learning-lesson-button"
                aria-current={isActive ? "true" : undefined}
                aria-label={`Play lesson ${lesson.lessonNumber}: ${lesson.title}`}
                onClick={() => onSelectLesson(index)}
                type="button"
              >
                <img alt="" decoding="async" loading="lazy" src={lesson.posterUrl} />
                <span>
                  <small>
                    {lesson.lessonNumber} · {lesson.duration}
                    {percent > 0 ? ` · ${progressLabel}` : ""}
                  </small>
                  <strong>{lesson.title}</strong>
                </span>
              </button>
              {lesson.script ? (
                <button
                  aria-label={`Open ${lesson.script.fileName} for ${lesson.title}`}
                  className="get-started-learning-script-button app-tooltip app-tooltip-right"
                  data-tooltip={`Open ${lesson.script.fileName}`}
                  onClick={() => onOpenScript(index)}
                  type="button"
                >
                  <FileText size={16} />
                </button>
              ) : null}
              <div
                aria-label={`${lesson.title}: ${progressLabel}`}
                aria-valuemax={100}
                aria-valuemin={0}
                aria-valuenow={percent}
                className={`get-started-learning-progress ${lessonProgress?.completed ? "complete" : ""}`}
                role="progressbar"
              >
                <i aria-hidden="true" style={{ width: `${percent}%` }} />
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function PostTrainingScriptFile({ lessonIndex }: { lessonIndex: number }) {
  const lesson = POST_TRAINING_LESSONS[lessonIndex] ?? POST_TRAINING_LESSONS[0]!;
  const scriptUrl = lesson.script?.url ?? "";
  const [script, setScript] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    setScript(null);
    setError(null);
    if (!scriptUrl) {
      setError("This lesson does not have a script.");
      return () => {
        active = false;
      };
    }

    void requestScript(scriptUrl).then(
      (content) => {
        if (active) setScript(content);
      },
      (reason: unknown) => {
        if (active) {
          setError(reason instanceof Error ? reason.message : "Could not open script");
        }
      },
    );
    return () => {
      active = false;
    };
  }, [retryToken, scriptUrl]);

  useEffect(() => {
    if (!copied) return undefined;
    const timeout = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  async function copyScript() {
    if (!script) return;
    const didCopy = await copyToClipboard(script);
    if (!didCopy) return;
    setCopied(true);
  }

  return (
    <>
      <div className="get-started-learning-panel-toolbar file">
        <span>
          <small>{lesson.slug}</small>
          <strong>{lesson.script?.fileName}</strong>
        </span>
        <button
          aria-label={copied ? "Script copied" : "Copy script for an LLM"}
          className="diff-icon-button"
          disabled={!script}
          onClick={() => void copyScript()}
          title={copied ? "Copied" : "Copy script for an LLM"}
          type="button"
        >
          <Copy size={14} />
        </button>
      </div>
      <div
        aria-busy={!script && !error}
        className="get-started-learning-panel-body script"
        data-script-url={scriptUrl}
        id="post-training-script-panel"
        aria-labelledby="post-training-script-tab"
        role="tabpanel"
      >
        {error ? (
          <div className="get-started-script-status error">
            <FileText size={18} />
            <span>{error}</span>
            <button onClick={() => setRetryToken((current) => current + 1)} type="button">
              <RotateCw size={14} />
              Try again
            </button>
          </div>
        ) : script ? (
          <div className="workspace-markdown-preview">
            <Suspense fallback={<ScriptLoadingState />}>
              <MarkdownText content={script} />
            </Suspense>
          </div>
        ) : (
          <ScriptLoadingState />
        )}
      </div>
    </>
  );
}

function ScriptLoadingState() {
  return (
    <div className="get-started-script-status">
      <BookOpenText size={18} />
      <span>Opening Markdown script…</span>
    </div>
  );
}
