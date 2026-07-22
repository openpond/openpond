import type { SidebarFileBookmark } from "@openpond/contracts";

export type SidebarFileOpenRequest = {
  id: number;
  file: SidebarFileBookmark;
};

export type ComposerAttachmentRequest = {
  id: number;
  file: File;
};
