export function saveComposerTaskDraft(input: {
  attachmentsCount: number;
  hasSelectedInvocation: boolean;
  onSave: (prompt: string) => Promise<boolean>;
  onSaved: () => void;
  prompt: string;
  saving: boolean;
  setSaving: (saving: boolean) => void;
  showInfo: (message: string) => void;
}) {
  if (input.saving) return;
  if (!input.prompt.trim()) {
    input.showInfo("Add task instructions before saving a draft.");
    return;
  }
  if (input.attachmentsCount > 0) {
    input.showInfo(
      "Task drafts currently save instructions only. Remove attachments before saving.",
    );
    return;
  }
  if (input.hasSelectedInvocation) {
    input.showInfo(
      "Finish or remove the selected command before saving this task draft.",
    );
    return;
  }
  input.setSaving(true);
  void input.onSave(input.prompt)
    .then((saved) => {
      if (saved) input.onSaved();
    })
    .finally(() => input.setSaving(false));
}

export function composerTaskDraftShortcut(
  key: string,
  shiftKey: boolean,
  experience: string,
  surface: string,
  supported: boolean,
): boolean {
  return key === "Enter"
    && shiftKey
    && experience === "work"
    && surface === "chat"
    && supported;
}

export function composerPlaceholder(input: {
  experience: string;
  mode: string;
  surface: string;
}): string {
  if (input.surface === "team") return "Message team";
  if (input.mode !== "start") return "Ask for follow-up changes";
  return input.experience === "chat"
    ? "Ask anything"
    : "What should we work on? Shift Enter to save as draft";
}
