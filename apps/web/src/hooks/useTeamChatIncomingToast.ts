import { useEffect, type Dispatch, type SetStateAction } from "react";
import type { ShowAppToast } from "../app/app-state";
import type { AppView } from "../lib/app-models";
import type { TeamChatIncomingNotification } from "../lib/team-chat-notifications";

export function useTeamChatIncomingToast(input: {
  notification: TeamChatIncomingNotification | null;
  dismiss: (eventId: number) => void;
  selectThread: (threadId: string) => Promise<void>;
  setView: Dispatch<SetStateAction<AppView>>;
  showToast: ShowAppToast;
}) {
  useEffect(() => {
    if (!input.notification) return;
    const { eventId, threadId, title, body } = input.notification;
    input.showToast(`${title}: ${body}`, "info", {
      actionLabel: "Open",
      onAction: () => {
        input.setView("team");
        void input.selectThread(threadId);
      },
      dismissible: true,
      durationMs: 6_500,
      placement: "top-right",
    });
    input.dismiss(eventId);
  }, [
    input.dismiss,
    input.notification,
    input.selectThread,
    input.setView,
    input.showToast,
  ]);
}
