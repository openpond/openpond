import { useMemo, useState } from "react";
import "../../styles/get-started/get-started-learning.css";
import "../../styles/get-started/get-started.css";
import { GetStartedDeckView } from "./GetStartedDeck";
import { GET_STARTED_DECKS, type GetStartedDeckId } from "./get-started-content";
import { MakeAgentTutorialCard } from "./MakeAgentTutorialCard";
import { PostTrainingSeries } from "./PostTrainingSeries";
import type { PostTrainingCourseState } from "./post-training-lessons";
import type { MakeAgentTutorialState } from "./make-agent-tutorial";

type GetStartedViewProps = {
  onCreateAgent: () => void;
  makeAgentTutorial: MakeAgentTutorialState | null;
  onCloseMakeAgentTutorial: () => void;
  onClosePostTrainingCourse: () => void;
  onOpenApps: () => void;
  onOpenChat: () => void;
  onOpenCloud: () => void;
  onOpenProfile: () => void;
  onOpenPostTrainingCourse: () => void;
  onOpenMakeAgentTutorial: () => void;
  onSelectPostTrainingLesson: (lessonIndex: number) => void;
  postTrainingCourse: PostTrainingCourseState | null;
};

export function GetStartedView({
  makeAgentTutorial,
  onCloseMakeAgentTutorial,
  onClosePostTrainingCourse,
  onOpenMakeAgentTutorial,
  onOpenPostTrainingCourse,
  onSelectPostTrainingLesson,
  postTrainingCourse,
}: GetStartedViewProps) {
  const [activeDeckId, setActiveDeckId] = useState<GetStartedDeckId>("goal");
  const [deckResetToken, setDeckResetToken] = useState(0);
  const activeDeck = useMemo(
    () => GET_STARTED_DECKS.find((deck) => deck.id === activeDeckId) ?? GET_STARTED_DECKS[0]!,
    [activeDeckId],
  );
  const playerOpen = Boolean(postTrainingCourse || makeAgentTutorial);

  function selectDeck(deckId: GetStartedDeckId) {
    setActiveDeckId(deckId);
    setDeckResetToken((current) => current + 1);
  }

  return (
    <section
      className={`get-started-view ${playerOpen ? "course-player-open" : ""}`}
      aria-label="Get started"
    >
      <div className="get-started-shell">
        <section className="get-started-learn" aria-labelledby="get-started-learn-title">
          <header className="get-started-section-heading">
            <h2 id="get-started-learn-title">Learn</h2>
          </header>
          <div className="get-started-learning-grid">
            <PostTrainingSeries
              activeLessonIndex={postTrainingCourse?.lessonIndex ?? 0}
              autoplay={postTrainingCourse?.autoplay ?? true}
              open={Boolean(postTrainingCourse)}
              onClose={onClosePostTrainingCourse}
              onOpen={onOpenPostTrainingCourse}
              onSelectLesson={onSelectPostTrainingLesson}
              playRequestId={postTrainingCourse?.playRequestId ?? 0}
            />
          </div>
        </section>

        <section className="get-started-walkthroughs" aria-labelledby="get-started-walkthroughs-title">
          <header className="get-started-section-heading">
            <h2 id="get-started-walkthroughs-title">Walkthroughs</h2>
          </header>
          <div className="get-started-learning-grid">
            <MakeAgentTutorialCard
              onClose={onCloseMakeAgentTutorial}
              onOpen={onOpenMakeAgentTutorial}
              open={Boolean(makeAgentTutorial)}
            />
          </div>
        </section>

        {playerOpen ? null : (
          <section className="get-started-guides" aria-labelledby="openpond-guides-title">
            <header className="get-started-section-heading">
              <h2 id="openpond-guides-title">How OpenPond works</h2>
            </header>

            <div className="surface-tabs get-started-tabs" role="tablist" aria-label="Get started topics">
              {GET_STARTED_DECKS.map((deck) => (
                <button
                  aria-selected={activeDeck.id === deck.id}
                  className={activeDeck.id === deck.id ? "active" : ""}
                  key={deck.id}
                  onClick={() => selectDeck(deck.id)}
                  role="tab"
                  type="button"
                >
                  <span>{deck.label}</span>
                </button>
              ))}
            </div>

            <GetStartedDeckView
              key={activeDeck.id}
              deck={activeDeck}
              resetToken={deckResetToken}
            />
          </section>
        )}
      </div>
    </section>
  );
}
