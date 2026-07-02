import { useMemo, useState, type ReactNode } from "react";
import { BookOpenText, Cloud, MessageSquare, Plug, Workflow } from "../icons";
import { GetStartedDeckView } from "./GetStartedDeck";
import { GET_STARTED_DECKS, type GetStartedDeckId } from "./get-started-content";

type GetStartedViewProps = {
  onCreateAgent: () => void;
  onOpenApps: () => void;
  onOpenChat: () => void;
  onOpenCloud: () => void;
  onOpenProfile: () => void;
};

export function GetStartedView({
  onCreateAgent,
  onOpenApps,
  onOpenChat,
  onOpenCloud,
  onOpenProfile,
}: GetStartedViewProps) {
  const [activeDeckId, setActiveDeckId] = useState<GetStartedDeckId>("goal");
  const [deckResetToken, setDeckResetToken] = useState(0);
  const activeDeck = useMemo(
    () => GET_STARTED_DECKS.find((deck) => deck.id === activeDeckId) ?? GET_STARTED_DECKS[0]!,
    [activeDeckId],
  );

  function selectDeck(deckId: GetStartedDeckId) {
    setActiveDeckId(deckId);
    setDeckResetToken((current) => current + 1);
  }

  return (
    <section className="get-started-view" aria-label="Get started">
      <div className="get-started-shell">
        <div className="get-started-tabs" role="tablist" aria-label="Get started topics">
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

        <div className="get-started-action-rail" aria-label="Related actions">
          <ActionButton icon={<Workflow size={15} />} label="Start a goal" onClick={onOpenChat} />
          <ActionButton icon={<MessageSquare size={15} />} label="Create an agent" onClick={onCreateAgent} />
          <ActionButton icon={<BookOpenText size={15} />} label="Open Profile" onClick={onOpenProfile} />
          <ActionButton icon={<Plug size={15} />} label="Connect apps" onClick={onOpenApps} />
          <ActionButton icon={<Cloud size={15} />} label="Open Cloud" onClick={onOpenCloud} />
        </div>
      </div>
    </section>
  );
}

function ActionButton({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button className="get-started-action-button" onClick={onClick} type="button">
      {icon}
      <span>{label}</span>
    </button>
  );
}
