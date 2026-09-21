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
  hasFilesOrActions: boolean;
  begin(scope: string): boolean;
  finish(scope: string): void;
  clear(): void;
  setError(message: string | null): void;
  stageLocal(body: string): void;
};

/** Keeps acceptance and draft clearing bound to the task where submission began. */
export function createComposerTaskSubmission(options: SubmissionOptions) {
  async function submit(kind: "steer" | "queued", promptOverride?: string): Promise<boolean> {
    const body = (promptOverride ?? options.getPrompt()).trim();
    if (!options.running || !body) return false;
    if (options.hasFilesOrActions) {
      options.showToast("Steering supports a plain-text instruction. Remove files or actions before sending it.", "info");
      return false;
    }
    if (kind === "queued" && !options.inbox.enabled) {
      options.stageLocal(body);
      options.clear();
      return true;
    }
    if (!options.begin(options.scope)) return false;
    options.setError(null);
    try {
      const sent = options.inbox.enabled
        ? kind === "steer"
          ? await options.inbox.steer(body)
          : await options.inbox.queue({
              prompt: body,
              modelRef: { providerId: options.provider, modelId: options.model },
              ...(options.provider === "codex" ? codexPermissionTurnInput(options.codexPermissionMode) : { approvalPolicy: "on-request", sandbox: "workspace-write" }),
              codexPermissionMode: options.codexPermissionMode,
              codexReasoningEffort: options.codexReasoningEffort,
            })
        : await options.onSubmit([], null, null, {
            preservePrompt: true, promptOverride: body, turnMetadata: { interactionKind: "steer" },
          });
      if (sent && (!options.getCurrentSubmissionScopeKey || options.getCurrentSubmissionScopeKey() === options.scope)) options.clear();
      return sent;
    } catch (error) {
      options.setError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      options.finish(options.scope);
    }
  }
  return {
    stageCurrentSteerDraft: (body?: string) => submit("queued", body),
    submitImmediateSteer: (body?: string) => submit("steer", body),
  };
}
