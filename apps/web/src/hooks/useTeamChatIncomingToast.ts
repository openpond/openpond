import { navigateDesktopRoute } from "../components/labs/lab-primary-tab-state";
import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { ShowAppToast } from "../app/app-state";
import type { AppView } from "../lib/app-models";
import type { TeamChatIncomingNotification } from "../lib/team-chat-notifications";

export function useTeamChatIncomingToast(input: {
  scope: string;
  notification: TeamChatIncomingNotification | null;
  dismiss: (eventId: number) => void;
  selectThread: (threadId: string) => Promise<void>;
  setView: Dispatch<SetStateAction<AppView>>;
  showToast: ShowAppToast;
}) {
  const scopeRef = useRef(input.scope);
  scopeRef.current = input.scope;
  useEffect(() => {
    if (!input.notification) return;
    const { eventId, threadId, title, body } = input.notification;
    const scope = input.scope;
    const isCurrent = () => scopeRef.current === scope;
    input.showToast(title, "info", {
      title: "New message", detail: body, kind: "team",
      dedupeKey: `team:${scope}:${eventId}`, actionLabel: "Open thread",
      onAction: async () => {
        if (!await navigateDesktopRoute({ kind: "view", view: "team" }, "push", isCurrent)) return false;
        if (!isCurrent()) return false;
        await input.selectThread(threadId);
        if (!isCurrent()) return false;
        input.setView("team");
        return true;
      },
    });
    input.dismiss(eventId);
  }, [
    input.scope,
    input.dismiss,
    input.notification,
    input.selectThread,
    input.setView,
    input.showToast,
  ]);
}
