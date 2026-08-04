import { useEffect, useRef, useState } from "react";

import {
  BookOpenText,
  CreditCard,
  FileText,
  Github,
  Globe2,
  HelpCircle,
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

type SidebarHelpMenuProps = {
  onOpenWalkthroughs: () => void;
  walkthroughsActive: boolean;
};

export function SidebarHelpMenu({
  onOpenWalkthroughs,
  walkthroughsActive,
}: SidebarHelpMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div className="sidebar-help-menu" ref={menuRef}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Open docs and help menu"
        className={`sidebar-icon sidebar-help-trigger ${
          walkthroughsActive ? "active" : ""
        }`}
        data-tooltip="Help"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <HelpCircle size={17} />
      </button>

      {open ? (
        <div className="sidebar-help-popover" role="menu" aria-label="Help">
          {SIDEBAR_HELP_ITEMS.map((item) => {
            const Icon = item.icon;
            const content = (
              <>
                <Icon size={15} />
                <span>{item.label}</span>
              </>
            );

            return item.destination === "walkthroughs" ? (
              <button
                aria-current={walkthroughsActive ? "page" : undefined}
                className="sidebar-help-item"
                key={item.label}
                onClick={() => {
                  setOpen(false);
                  onOpenWalkthroughs();
                }}
                role="menuitem"
                type="button"
              >
                {content}
              </button>
            ) : (
              <a
                className="sidebar-help-item"
                href={item.url}
                key={item.label}
                onClick={(event) => {
                  event.preventDefault();
                  setOpen(false);
                  void openExternalUrl(item.url);
                }}
                rel="noreferrer"
                role="menuitem"
                target="_blank"
              >
                {content}
              </a>
            );
          })}
        </div>
      ) : null}
    </div>
  );
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
