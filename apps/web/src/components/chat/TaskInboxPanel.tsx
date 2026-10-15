import { ErrorToast } from "../common/ErrorToast";
import { TaskResourceContextsSchema, type TaskResourceContext, type TaskInput } from "@openpond/contracts";
import type { TaskInboxController } from "../../hooks/useTaskInbox";
import { ComposerSteerRow } from "./ComposerSteerRow";

export function TaskInboxPanel({ inbox, onRestore, canRestore }: {
  inbox: TaskInboxController;
  canRestore?(contexts: TaskResourceContext[]): boolean;
  onRestore(body: string, contexts: TaskResourceContext[]): void;
}) {
  const snapshot = inbox.snapshot;
  const queued = snapshot?.inputs.filter((input) => input.senderKind === "user" && input.kind === "queued" && input.state === "pending") ?? [];
  if (!queued.length && !inbox.error) return null;

  return <>
    {inbox.error && <ErrorToast error={inbox.error} />}
    {queued.length > 0 && <div className="composer-steer-stack" aria-label="Queued messages">
      {queued.map((input) => {
        const activeTurnId = snapshot?.activeTurnId;
        const starting = Boolean(input.turnId);
        const actionLabel = starting ? "Starting" : activeTurnId ? "Steer" : snapshot?.paused ? "Resume" : "Send";
        const actionDisabledReason = starting
          ? "This message is starting its turn."
          : activeTurnId && !snapshot?.acceptingInput
            ? "This turn is no longer accepting steering. The message stays queued for the next turn."
            : undefined;
        return <ComposerSteerRow
          key={input.id}
          prompt={input.body}
          disabled={Boolean(inbox.busyId) || starting}
          actionLabel={actionLabel}
          actionDisabledReason={actionDisabledReason}
          onSend={() => void inbox.mutate(input, activeTurnId
            ? { action: "steer", expectedRevision: input.revision, expectedTurnId: activeTurnId }
            : { action: "resume", expectedRevision: input.revision })}
          onDelete={() => void inbox.mutate(input, { action: "cancel", expectedRevision: input.revision })}
          onEdit={() => void restoreQueuedTaskInput(inbox, input, onRestore, canRestore)}
        />;
      })}
    </div>}
  </>;
}

/** Remove the saved queue entry before returning its text to the composer. */
export async function restoreQueuedTaskInput(
  inbox: Pick<TaskInboxController, "mutate">,
  input: TaskInput,
  onRestore: (body: string, contexts: TaskResourceContext[]) => void,
  canRestore?: (contexts: TaskResourceContext[]) => boolean,
): Promise<void> {
  const metadata = input.payload.metadata as Record<string, unknown> | undefined;
  const parsed = TaskResourceContextsSchema.safeParse(metadata?.chatResourceContexts);
  const contexts = parsed.success ? parsed.data : [];
  if (canRestore && !canRestore(contexts)) return;
  if (await inbox.mutate(input, { action: "cancel", expectedRevision: input.revision })) {
    onRestore(input.body, contexts);
  }
}
