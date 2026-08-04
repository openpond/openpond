import { useState } from "react";
import "../../styles/get-started/get-started-learning.css";
import { MakeAgentTutorialCard } from "./MakeAgentTutorialCard";
import { LearningVideoCard } from "./LearningVideoCard";
import { PostTrainingSeries } from "./PostTrainingSeries";
import { OPENPOND_AGENT_OVERVIEW } from "./openpond-agent-overview";
import type { PostTrainingCourseState } from "./post-training-lessons";
import type {
  MakeAgentTutorialState,
  MakeAgentTutorialVideoId,
} from "./make-agent-tutorial";

type GetStartedViewProps = {
  makeAgentTutorial?: MakeAgentTutorialState | null;
  onCloseMakeAgentTutorial?: () => void;
  onClosePostTrainingCourse?: () => void;
  onOpenPostTrainingCourse?: () => void;
  onOpenMakeAgentTutorial?: () => void;
  onSelectMakeAgentTutorialVideo?: (videoId: MakeAgentTutorialVideoId) => void;
  onSelectPostTrainingLesson?: (lessonIndex: number) => void;
  postTrainingCourse?: PostTrainingCourseState | null;
};

export function GetStartedView(props: GetStartedViewProps = {}) {
  const [localMakeAgentTutorial, setLocalMakeAgentTutorial] =
    useState<MakeAgentTutorialState | null>(null);
  const [localPostTrainingCourse, setLocalPostTrainingCourse] =
    useState<PostTrainingCourseState | null>(null);
  const makeAgentTutorial =
    props.makeAgentTutorial === undefined
      ? localMakeAgentTutorial
      : props.makeAgentTutorial;
  const postTrainingCourse =
    props.postTrainingCourse === undefined
      ? localPostTrainingCourse
      : props.postTrainingCourse;
  const playerOpen = Boolean(postTrainingCourse || makeAgentTutorial);

  function openMakeAgentTutorial() {
    if (props.onOpenMakeAgentTutorial) {
      props.onOpenMakeAgentTutorial();
      return;
    }
    setLocalPostTrainingCourse(null);
    setLocalMakeAgentTutorial({
      autoplay: true,
      playRequestId: 0,
      videoId: "create",
    });
  }

  function closeMakeAgentTutorial() {
    if (props.onCloseMakeAgentTutorial) {
      props.onCloseMakeAgentTutorial();
      return;
    }
    setLocalMakeAgentTutorial(null);
  }

  function selectMakeAgentTutorialVideo(videoId: MakeAgentTutorialVideoId) {
    if (props.onSelectMakeAgentTutorialVideo) {
      props.onSelectMakeAgentTutorialVideo(videoId);
      return;
    }
    setLocalMakeAgentTutorial((current) =>
      current
        ? {
            ...current,
            playRequestId: current.playRequestId + 1,
            videoId,
          }
        : current
    );
  }

  function openPostTrainingCourse() {
    if (props.onOpenPostTrainingCourse) {
      props.onOpenPostTrainingCourse();
      return;
    }
    setLocalMakeAgentTutorial(null);
    setLocalPostTrainingCourse({
      autoplay: true,
      fullCourseSelected: false,
      lessonIndex: 0,
      playRequestId: 0,
    });
  }

  function closePostTrainingCourse() {
    if (props.onClosePostTrainingCourse) {
      props.onClosePostTrainingCourse();
      return;
    }
    setLocalPostTrainingCourse(null);
  }

  function selectPostTrainingLesson(lessonIndex: number) {
    if (props.onSelectPostTrainingLesson) {
      props.onSelectPostTrainingLesson(lessonIndex);
      return;
    }
    setLocalPostTrainingCourse((current) =>
      current
        ? {
            ...current,
            fullCourseSelected: false,
            lessonIndex,
            playRequestId: current.playRequestId + 1,
          }
        : current
    );
  }

  return (
    <section
      className={`get-started-view ${playerOpen ? "course-player-open" : ""}`}
      aria-label="Walkthroughs"
    >
      <div className="get-started-shell">
        <section
          className="get-started-start-here"
          aria-labelledby="get-started-start-here-title"
        >
          <header className="get-started-section-heading">
            <h2 id="get-started-start-here-title">Start here</h2>
          </header>
          <div className="get-started-learning-grid">
            <LearningVideoCard
              titleElement="h1"
              video={OPENPOND_AGENT_OVERVIEW}
            />
          </div>
        </section>

        <section
          className="get-started-walkthroughs"
          aria-labelledby="get-started-walkthroughs-title"
        >
          <header className="get-started-section-heading">
            <h2 id="get-started-walkthroughs-title">Walkthroughs</h2>
          </header>
          <div className="get-started-learning-grid">
            <MakeAgentTutorialCard
              activeVideoId={makeAgentTutorial?.videoId ?? "create"}
              autoplay={makeAgentTutorial?.autoplay ?? true}
              onClose={closeMakeAgentTutorial}
              onOpen={openMakeAgentTutorial}
              onSelectVideo={selectMakeAgentTutorialVideo}
              open={Boolean(makeAgentTutorial)}
              playRequestId={makeAgentTutorial?.playRequestId ?? 0}
            />
          </div>
        </section>

        <section
          className="get-started-learn"
          aria-labelledby="get-started-learn-title"
        >
          <header className="get-started-section-heading">
            <h2 id="get-started-learn-title">Learn deeper</h2>
          </header>
          <div className="get-started-learning-grid">
            <PostTrainingSeries
              activeLessonIndex={postTrainingCourse?.lessonIndex ?? 0}
              autoplay={postTrainingCourse?.autoplay ?? true}
              fullCourseSelected={
                postTrainingCourse?.fullCourseSelected ?? false
              }
              open={Boolean(postTrainingCourse)}
              onClose={closePostTrainingCourse}
              onOpen={openPostTrainingCourse}
              onSelectLesson={selectPostTrainingLesson}
              playRequestId={postTrainingCourse?.playRequestId ?? 0}
            />
          </div>
        </section>

      </div>
    </section>
  );
}
