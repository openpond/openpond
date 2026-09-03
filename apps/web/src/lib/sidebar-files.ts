import type { SidebarFileBookmark } from "@openpond/contracts";

export type SidebarFileOpenRequest = {
  id: number;
  conversationId: string;
  file: SidebarFileBookmark;
};

export function sidebarFileOpenRequestMatchesConversation(
  request: SidebarFileOpenRequest | null,
  conversationId: string,
): request is SidebarFileOpenRequest {
  return request?.conversationId === conversationId;
}

export function clearHandledSidebarFileOpenRequest(
  request: SidebarFileOpenRequest | null,
  handledRequestId: number,
): SidebarFileOpenRequest | null {
  return request?.id === handledRequestId ? null : request;
}

export type ComposerAttachmentRequest = {
  id: number;
  file: File;
};
