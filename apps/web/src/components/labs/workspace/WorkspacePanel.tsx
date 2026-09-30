import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
export const WorkspacePanelHost = createContext<HTMLElement | null>(null);
/** All editors and inspectors dock into the same shell column. The column
 * consumes layout width, so tables stay readable while a panel is open. */
export function WorkspacePanel({ children, label }: { children: ReactNode; label: string }) {
  const host = useContext(WorkspacePanelHost);
  return host ? createPortal(<section aria-label={label}>{children}</section>, host) : null;
}
