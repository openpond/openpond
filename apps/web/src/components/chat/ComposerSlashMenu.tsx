import type { CSSProperties } from "react";
import { useEffect, useRef } from "react";
import { AtSign, Bot, Check, Plus, Workflow } from "../icons";
import type { OpenPondApp } from "@openpond/contracts";
import type { SandboxActionCatalogEntry } from "../../lib/sandbox-types";
import {
  composerActionCatalogHint,
  composerActionCatalogLabel,
} from "../../lib/composer-action-catalog";
import {
  composerSlashCommandDetail,
  type ComposerSlashCommand,
} from "../../lib/composer-slash-commands";

export type SlashMenuItem =
  | { kind: "command"; command: ComposerSlashCommand }
  | { kind: "app-context"; app: OpenPondApp }
  | { kind: "action"; action: SandboxActionCatalogEntry };

function isAgentSlashAction(action: SandboxActionCatalogEntry): boolean {
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

export function ComposerSlashMenu({
  actionCatalogCount,
  actionIndex,
  items,
  onSelect,
  onSelectIndex,
  style,
}: {
  actionCatalogCount: number;
  actionIndex: number;
  items: SlashMenuItem[];
  onSelect: (item: SlashMenuItem) => void;
  onSelectIndex: (index: number) => void;
  style: CSSProperties;
}) {
  const selectedOptionRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    selectedOptionRef.current?.scrollIntoView({ block: "nearest" });
  }, [actionIndex, items.length]);

  return (
    <div
      className="composer-project-menu composer-slash-menu"
      role="listbox"
      aria-label="OpenPond agents and actions"
      style={style}
    >
      {items.length > 0 ? (
        items.map((item, index) => (
          <button
            key={slashMenuItemKey(item)}
            type="button"
            role="option"
            ref={index === actionIndex ? selectedOptionRef : undefined}
            aria-selected={index === actionIndex}
            className={`composer-project-option ${index === actionIndex ? "selected" : ""}`}
            data-app-context-id={item.kind === "app-context" ? item.app.id : undefined}
            onMouseEnter={() => onSelectIndex(index)}
            onMouseDown={(event) => {
              event.preventDefault();
              onSelect(item);
            }}
          >
            {item.kind === "command" ? (
              item.command.id === "create" ? <Plus size={14} /> : <Workflow size={14} />
            ) : item.kind === "app-context" ? (
              <AtSign size={14} />
            ) : isAgentSlashAction(item.action) ? (
              <Bot size={14} />
            ) : (
              <Workflow size={14} />
            )}
            <span>
              <strong>{slashMenuItemLabel(item)}</strong>
              <small>{slashMenuItemDetail(item)}</small>
            </span>
            {index === actionIndex ? <Check size={14} /> : <span aria-hidden="true" />}
          </button>
        ))
      ) : (
        <div className="composer-menu-empty" role="option" aria-selected="false">
          {actionCatalogCount === 0 ? "No matching commands or apps" : "No matching commands, apps, agents, or actions"}
        </div>
      )}
    </div>
  );
}
