import type { ChatAttachment, TaskResourceContext } from "@openpond/contracts";
import { composerResourceMetadata } from "./composer-resource-context";
import type { TaskInboxController } from "../../hooks/useTaskInbox";
import { codexPermissionTurnInput } from "../../lib/app-models";
import type { ComposerProps } from "./composer-types";

type SubmissionOptions = Pick<ComposerProps,
  "provider" | "model" | "codexPermissionMode" | "codexReasoningEffort" |
  "openPondCommandAccessMode" | "getCurrentSubmissionScopeKey" | "onSubmit" | "showToast"
> & {
  running: boolean;
  scope: string;
  inbox: TaskInboxController;
  getPrompt(): string;
  getResourceContexts?(): TaskResourceContext[];
  hasActions: boolean;
  attachmentCount?: number;
  prepareAttachments?(): Promise<{ attachments: ChatAttachment[]; settle(accepted: boolean): void }>;
  begin(scope: string): boolean;
  finish(scope: string): void;
  clear(): void;
  setError(message: string | null): void;
  stageLocal(body: string, contexts?: TaskResourceContext[], attachments?: ChatAttachment[]): void;
};

/** Keeps acceptance and draft clearing bound to the task where submission began. */
export function createComposerTaskSubmission(options: SubmissionOptions) {
  async function submit(kind: "steer" | "queued", promptOverride?: string): Promise<boolean> {
    const body = (promptOverride ?? options.getPrompt()).trim() || (options.attachmentCount ? "Please review the attached files." : "");
    if (!options.running || !body) return false;
    const contexts = options.getResourceContexts?.() ?? [];
    if (options.hasActions) {
      options.showToast("Send the selected action as a separate message before steering this turn.", "info");
      return false;
    }
    if (!options.begin(options.scope)) return false;
    options.setError(null);
    let prepared: Awaited<ReturnType<NonNullable<SubmissionOptions["prepareAttachments"]>>> | undefined;
    let accepted = false;
    try {
      prepared = await options.prepareAttachments?.();
      const attachments = prepared?.attachments ?? [];
      if (kind === "queued" && !options.inbox.enabled) {
        options.stageLocal(body, contexts, attachments);
        options.clear();
        accepted = true;
        return true;
      }
      const sent = options.inbox.enabled
        ? kind === "steer"
          ? await options.inbox.steer(body, contexts, attachments.length ? attachments : undefined)
          : await options.inbox.queue({
              prompt: body,
              attachments,
              metadata: composerResourceMetadata(contexts),
              modelRef: { providerId: options.provider, modelId: options.model },
              ...(options.provider === "codex" ? codexPermissionTurnInput(options.codexPermissionMode) : { approvalPolicy: "on-request", sandbox: "workspace-write" }),
              codexPermissionMode: options.codexPermissionMode,
              codexReasoningEffort: options.codexReasoningEffort,
            })
        : await options.onSubmit(attachments, null, null, {
            preservePrompt: true, promptOverride: body, turnMetadata: { ...composerResourceMetadata(contexts), interactionKind: "steer" },
          });
      if (sent && (!options.getCurrentSubmissionScopeKey || options.getCurrentSubmissionScopeKey() === options.scope)) options.clear();
      accepted = sent;
      return sent;
    } catch (error) {
      options.setError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      prepared?.settle(accepted);
      options.finish(options.scope);
    }
  }
  return {
    stageCurrentSteerDraft: (body?: string) => submit("queued", body),
    submitImmediateSteer: (body?: string) => submit("steer", body),
  };
}
