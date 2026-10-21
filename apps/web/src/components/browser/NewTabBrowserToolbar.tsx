import { useAppToast } from "../../app/AppToastContext";
import { useBrowserSidebar } from "../../hooks/useBrowserSidebar";
import { BrowserToolbar } from "./BrowserToolbar";
import "../../styles/browser/browser-sidebar.css";

export function NewTabBrowserToolbar({ conversationId, onOpenBrowser }: { conversationId: string; onOpenBrowser: () => void }) {
  const browser = useBrowserSidebar(conversationId);
  const toast = useAppToast();
  return <BrowserToolbar activeTab={null} available={browser.available}
    onBack={() => {}} onForward={() => {}} onReload={() => {}} onStop={() => {}} onOpenExternal={() => {}}
    onClearData={() => {
      if (window.confirm("Clear shared browser data? Cookies, logins, cache, and site storage will be removed for all chats. This chat's browser tabs will also close.")) void browser.clearData();
    }}
    onNavigate={url => {
      void browser.open(url, { explicitFile: true, newTab: true }).then(opened => { if (opened) onOpenBrowser(); })
        .catch(error => toast?.(error instanceof Error ? error.message : "Could not open browser.", "error"));
    }} />;
}
