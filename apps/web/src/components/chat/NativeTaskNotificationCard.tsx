import type { NativeTaskNotification } from "../../lib/native-task-notification";
import { CircleAlert, Check, SquareTerminal } from "../icons";

export function NativeTaskNotificationCard({
  notification,
  onOpenFile,
}: {
  notification: NativeTaskNotification;
  onOpenFile?: (path: string) => void;
}) {
  const label =
    notification.status === "completed"
      ? "Background task completed"
      : notification.status === "failed"
        ? "Background task failed"
        : "Background task stopped";
  return (
    <article className={`native-task-notification ${notification.status}`} aria-label={label}>
      <header>
        {notification.status === "completed" ? <Check size={14} /> : <CircleAlert size={14} />}
        <strong>{label}</strong>
      </header>
      <p>{notification.summary}</p>
      <details>
        <summary>Task details</summary>
        <code>{notification.taskId}</code>
        {notification.outputFile ? (
          <div>
            {onOpenFile ? (
              <button type="button" onClick={() => onOpenFile(notification.outputFile!)}>
                <SquareTerminal size={13} />
                Open output
              </button>
            ) : (
              <code>{notification.outputFile}</code>
            )}
          </div>
        ) : null}
      </details>
    </article>
  );
}
