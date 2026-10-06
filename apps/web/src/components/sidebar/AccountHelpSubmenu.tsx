import { useLayoutEffect, useRef, useState } from "react";

import {
  BookOpenText,
  CreditCard,
  FileText,
  Github,
  Globe2,
  HelpCircle,
  ChevronRight,
  MessageSquare,
  type LucideIcon,
} from "../icons";

type SidebarHelpItem = {
  icon: LucideIcon;
  label: string;
} & (
  | { destination: "walkthroughs" }
  | { destination: "external"; url: string }
);

export const SIDEBAR_HELP_ITEMS = [
  {
    destination: "walkthroughs",
    icon: BookOpenText,
    label: "Walkthroughs",
  },
  {
    destination: "external",
    icon: BookOpenText,
    label: "Docs",
    url: "https://openpond.ai/docs",
  },
  {
    destination: "external",
    icon: FileText,
    label: "Blog",
    url: "https://openpond.ai/blog",
  },
  {
    destination: "external",
    icon: CreditCard,
    label: "Pricing",
    url: "https://openpond.ai/pricing",
  },
  {
    destination: "external",
    icon: Globe2,
    label: "Web app",
    url: "https://openpond.ai/sandboxes",
  },
  {
    destination: "external",
    icon: Github,
    label: "GitHub",
    url: "https://github.com/openpond/openpond",
  },
  {
    destination: "external",
    icon: MessageSquare,
    label: "Submit issue",
    url: "https://github.com/openpond/openpond/issues/new/choose",
  },
] as const satisfies readonly SidebarHelpItem[];

type AccountHelpSubmenuProps = {
  onOpenWalkthroughs: () => void;
  onCloseAccount: () => void;
  walkthroughsActive: boolean;
};

export function AccountHelpSubmenu({ onOpenWalkthroughs, onCloseAccount, walkthroughsActive }: AccountHelpSubmenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (open) submenuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  function openAndFocus() {
    setOpen(true);
  }

  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  return <div className="user-auth-help" onKeyDown={(event) => {
    if (open && (event.key === "Escape" || event.key === "ArrowLeft")) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }}>
    <button ref={triggerRef} type="button" className="user-auth-menu-link" role="menuitem"
      aria-haspopup="menu" aria-expanded={open}
      onClick={() => open ? close() : openAndFocus()}
      onKeyDown={(event) => {
        if (event.key === "ArrowRight") { event.preventDefault(); openAndFocus(); }
      }}>
      <HelpCircle size={15} /><span>Help</span><ChevronRight className="user-auth-help-chevron" size={14} />
    </button>
    {open ? <div ref={submenuRef} className="user-auth-help-submenu" role="menu" aria-label="Help"
      onKeyDown={(event) => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const items = Array.from(submenuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
        const current = items.indexOf(document.activeElement as HTMLElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }}>
      {SIDEBAR_HELP_ITEMS.map((item) => {
        const Icon = item.icon;
        const content = <><Icon size={15} /><span>{item.label}</span></>;
        return item.destination === "walkthroughs" ? <button key={item.label} type="button" role="menuitem"
          className="user-auth-menu-link" aria-current={walkthroughsActive ? "page" : undefined}
          onClick={() => { onCloseAccount(); onOpenWalkthroughs(); }}>{content}</button>
          : <a key={item.label} className="user-auth-menu-link" role="menuitem" href={item.url}
            target="_blank" rel="noreferrer" onClick={(event) => {
              event.preventDefault(); onCloseAccount(); void openExternalUrl(item.url);
            }}>{content}</a>;
      })}
    </div> : null}
  </div>;
}

async function openExternalUrl(url: string): Promise<void> {
  const browser = window.openpond?.browser;
  if (browser?.openExternal) {
    const result = await browser.openExternal({
      conversationId: "openpond-help",
      url,
    });
    if (result.ok) return;
  }

  window.open(url, "_blank", "noopener,noreferrer");
}
