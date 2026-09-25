import type { ReactNode } from "react";
import { AppDialog } from "../../dialogs/AppDialog";
import { requestDesktopViewChange } from "../lab-primary-tab-state";

export function LearningEditorDialog({ title, children, onClose, wide = false, fullPage = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean; fullPage?: boolean }) {
  return <AppDialog ariaLabel={title} className={`learning-editor-dialog ${wide ? "learning-review-dialog" : ""} ${fullPage ? "learning-review-full-page" : ""}`} backdropClassName={`labs-rename-backdrop ${fullPage ? "learning-review-full-backdrop" : ""}`} onClose={() => { void requestDesktopViewChange(onClose); }}>
    {children}
  </AppDialog>;
}
