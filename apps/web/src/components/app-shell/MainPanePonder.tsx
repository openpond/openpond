import type { ComponentProps } from "react";
import { PonderDesktopPanel } from "../ponder/PonderDesktopPanel";

type Props = Omit<ComponentProps<typeof PonderDesktopPanel>, "onOpenWork"> & {
  accountBaseUrl: string | null;
  onOpenBrowserLink(href: string, options?: { explicitFile?: boolean; newTab?: boolean }): void;
};

/** Keep hosted task links in the current account's desktop browser workspace. */
export function MainPanePonder({ accountBaseUrl, onOpenBrowserLink, ...panel }: Props) {
  function openWork(conversationId: string) {
    if (!accountBaseUrl) {
      panel.composer.showToast("OpenPond account URL is unavailable for this Work task.", "error");
      return;
    }
    try {
      const url = new URL(`/tasks/${encodeURIComponent(conversationId)}`, accountBaseUrl);
      onOpenBrowserLink(url.toString(), { newTab: true });
    } catch {
      panel.composer.showToast("OpenPond account URL is invalid for this Work task.", "error");
    }
  }
  return <PonderDesktopPanel {...panel} onOpenWork={openWork} />;
}
