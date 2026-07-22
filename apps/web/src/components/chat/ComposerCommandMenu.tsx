import type { CSSProperties, RefObject } from "react";
import { useEffect, useRef } from "react";
import type { OpenPondApp, TeamChatMember } from "@openpond/contracts";
import {
  AtSign,
  Bot,
  Check,
  Paperclip,
  Plus,
  Workflow,
} from "../icons";
import {
  actionMentionDetail,
  actionMentionLabel,
} from "../../lib/action-mentions";
import {
  composerActionCatalogHint,
  composerActionCatalogLabel,
} from "../../lib/composer-action-catalog";
import type { ConnectedAppMentionOption } from "../../lib/connected-app-mentions";
import { connectedAppIconUrl } from "../../lib/public-assets";
import type { SandboxActionCatalogEntry } from "../../lib/sandbox-types";
import {
  composerSlashCommandDetail,
  type ComposerSlashCommand,
} from "../../lib/composer-slash-commands";

export type SlashMenuItem =
  | { kind: "command"; command: ComposerSlashCommand }
  | { kind: "app-context"; app: OpenPondApp }
  | { kind: "action"; action: SandboxActionCatalogEntry };

export type ComposerMentionMenuItem =
  | { kind: "app"; app: OpenPondApp }
  | { kind: "connected-app"; app: ConnectedAppMentionOption }
  | { kind: "team-member"; member: TeamChatMember }
  | { kind: "action"; action: SandboxActionCatalogEntry };

export type ComposerCommandMenuItem =
  | { kind: "files" }
  | { kind: "slash"; item: SlashMenuItem }
  | { kind: "mention"; item: ComposerMentionMenuItem };

export type ComposerCommandMenuSection = {
  emptyLabel?: string;
  id: string;
  items: ComposerCommandMenuItem[];
  label: string;
};

function isAgentAction(action: SandboxActionCatalogEntry): boolean {
  return action.implementation?.type === "openpond-agent";
}

function slashMenuItemKey(item: SlashMenuItem): string {
  if (item.kind === "command") return `command:${item.command.id}`;
  if (item.kind === "app-context") return `app-context:${item.app.id}`;
  return `action:${item.action.id}`;
}

function slashMenuItemLabel(item: SlashMenuItem): string {
  if (item.kind === "command") return `${item.command.command} ${item.command.label}`;
  if (item.kind === "app-context") return item.app.name;
  return composerActionCatalogLabel(item.action);
}

function slashMenuItemDetail(item: SlashMenuItem): string {
  if (item.kind === "command") return composerSlashCommandDetail(item.command);
  if (item.kind === "app-context") {
    return `Planning context${item.app.description ? `: ${item.app.description}` : item.app.gitRepo ? `: ${item.app.gitRepo}` : ""}`;
  }
  return item.action.description || composerActionCatalogHint(item.action);
}

function mentionMenuItemKey(item: ComposerMentionMenuItem): string {
  if (item.kind === "app") return `app:${item.app.id}`;
  if (item.kind === "connected-app") return `connected-app:${item.app.provider}`;
  if (item.kind === "team-member") return `team-member:${item.member.userId}`;
  return `action:${item.action.id}`;
}

function mentionMenuItemLabel(item: ComposerMentionMenuItem): string {
  if (item.kind === "app") return item.app.name;
  if (item.kind === "connected-app") return item.app.label;
  if (item.kind === "team-member") return item.member.name;
  return actionMentionLabel(item.action);
}

function mentionMenuItemDetail(item: ComposerMentionMenuItem): string {
  if (item.kind === "action") return actionMentionDetail(item.action);
  if (item.kind === "connected-app") return item.app.detail;
  if (item.kind === "team-member") {
    return item.member.handle ? `@${item.member.handle}` : "Team member";
  }
  const actionNames = item.app.sandboxActionRegistry?.actions.map((action) => action.name) ?? [];
  return actionNames.length > 0
    ? `Actions: ${actionNames.slice(0, 4).join(", ")}${actionNames.length > 4 ? ` +${actionNames.length - 4}` : ""}`
    : item.app.sandboxManifestError
      ? "Manifest registry unavailable"
      : item.app.description || item.app.gitRepo || item.app.id;
}

function menuItemKey(item: ComposerCommandMenuItem): string {
  if (item.kind === "files") return "files";
  if (item.kind === "slash") return `slash:${slashMenuItemKey(item.item)}`;
  return `mention:${mentionMenuItemKey(item.item)}`;
}

function menuItemLabel(item: ComposerCommandMenuItem): string {
  if (item.kind === "files") return "Files and folders";
  if (item.kind === "slash") return slashMenuItemLabel(item.item);
  return mentionMenuItemLabel(item.item);
}

function menuItemDetail(item: ComposerCommandMenuItem): string {
  if (item.kind === "files") return "Attach images, documents, or other files";
  if (item.kind === "slash") return slashMenuItemDetail(item.item);
  return mentionMenuItemDetail(item.item);
}

function menuItemMatchesQuery(item: ComposerCommandMenuItem, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = `${menuItemLabel(item)} ${menuItemDetail(item)}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

export function filterComposerCommandMenuSections(
  sections: ComposerCommandMenuSection[],
  rawQuery: string,
): ComposerCommandMenuSection[] {
  const query = rawQuery.trimStart();
  const scope = query.startsWith("/") ? "slash" : query.startsWith("@") ? "mentions" : null;
  const searchQuery = scope ? query.slice(1).trimStart() : query;
  const scopedSections = scope ? sections.filter((section) => section.id === scope) : sections;
  if (!searchQuery) return scopedSections;

  const matches = scopedSections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => menuItemMatchesQuery(item, searchQuery)),
    }))
    .filter((section) => section.items.length > 0);
  if (matches.length > 0) return matches;

  const emptySection = scope ? scopedSections[0] : null;
  return [{
    ...(emptySection ?? { id: "results", label: "Results" }),
    emptyLabel: scope === "slash"
      ? "No slash commands match"
      : scope === "mentions"
        ? "No mentions match"
        : "No commands match",
    items: [],
  }];
}

function menuItemIcon(item: ComposerCommandMenuItem) {
  if (item.kind === "files") return <Paperclip size={14} />;
  if (item.kind === "slash") {
    const slashItem = item.item;
    if (slashItem.kind === "command") {
      return slashItem.command.id === "create" ? <Plus size={14} /> : <Workflow size={14} />;
    }
    if (slashItem.kind === "app-context") return <AtSign size={14} />;
    return isAgentAction(slashItem.action) ? <Bot size={14} /> : <Workflow size={14} />;
  }
  const mentionItem = item.item;
  if (mentionItem.kind === "connected-app") {
    return (
      <img
        alt=""
        className="composer-provider-mention-icon"
        draggable={false}
        src={connectedAppIconUrl(mentionItem.app.provider)}
      />
    );
  }
  if (mentionItem.kind === "action") {
    return isAgentAction(mentionItem.action) ? <Bot size={14} /> : <Workflow size={14} />;
  }
  return <AtSign size={14} />;
}

function appContextId(item: ComposerCommandMenuItem): string | undefined {
  if (item.kind === "slash" && item.item.kind === "app-context") return item.item.app.id;
  if (item.kind === "mention" && item.item.kind === "app") return item.item.app.id;
  return undefined;
}

export function ComposerCommandMenu({
  ariaLabel,
  className = "",
  id,
  menuIndex,
  menuRef,
  onSelect,
  onSelectIndex,
  sections,
  style,
  variant,
}: {
  ariaLabel: string;
  className?: string;
  id?: string;
  menuIndex: number;
  menuRef?: RefObject<HTMLDivElement | null>;
  onSelect: (item: ComposerCommandMenuItem) => void;
  onSelectIndex: (index: number) => void;
  sections: ComposerCommandMenuSection[];
  style?: CSSProperties;
  variant: "add" | "typed";
}) {
  const selectedOptionRef = useRef<HTMLButtonElement | null>(null);
  const itemCount = sections.reduce((count, section) => count + section.items.length, 0);

  useEffect(() => {
    if (variant === "add" && menuIndex === 0) {
      const menu = selectedOptionRef.current?.closest<HTMLElement>(".composer-command-menu");
      if (menu) menu.scrollTop = 0;
      return;
    }
    selectedOptionRef.current?.scrollIntoView({ block: "nearest" });
  }, [itemCount, menuIndex, variant]);

  let itemOffset = 0;
  return (
    <div
      ref={menuRef}
      id={id}
      className={`composer-project-menu composer-slash-menu ${className} composer-command-menu composer-command-menu-${variant}`.trim()}
      role={variant === "add" ? "menu" : "listbox"}
      aria-label={ariaLabel}
      style={style}
    >
      {sections.map((section) => {
        const sectionOffset = itemOffset;
        itemOffset += section.items.length;
        return (
          <div
            className="composer-command-section"
            key={section.id}
            role="group"
            aria-label={section.label}
          >
            <div className="composer-command-section-title">{section.label}</div>
            {section.items.length > 0 ? (
              section.items.map((item, index) => {
                const menuItemIndex = sectionOffset + index;
                const selected = menuItemIndex === menuIndex;
                return (
                  <button
                    key={menuItemKey(item)}
                    type="button"
                    role={variant === "add" ? "menuitem" : "option"}
                    ref={selected ? selectedOptionRef : undefined}
                    aria-selected={variant === "typed" ? selected : undefined}
                    className={`composer-project-option ${selected ? "selected" : ""} composer-command-option`}
                    data-app-context-id={appContextId(item)}
                    onFocus={() => onSelectIndex(menuItemIndex)}
                    onMouseEnter={() => onSelectIndex(menuItemIndex)}
                    onMouseDown={(event) => {
                      event.preventDefault();
                    }}
                    onClick={() => onSelect(item)}
                  >
                    {menuItemIcon(item)}
                    <span>
                      <strong>{menuItemLabel(item)}</strong>
                      <small>{menuItemDetail(item)}</small>
                    </span>
                    {variant === "typed" && selected ? <Check size={14} /> : <span aria-hidden="true" />}
                  </button>
                );
              })
            ) : (
              <div className="composer-menu-empty">{section.emptyLabel ?? "No items available"}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
