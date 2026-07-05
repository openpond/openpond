import type { CSSProperties } from "react";
import { useEffect, useRef } from "react";
import { AtSign, Bot, Check, Workflow } from "../icons";
import type { OpenPondApp } from "@openpond/contracts";
import {
  actionMentionDetail,
  actionMentionLabel,
} from "../../lib/action-mentions";
import type { ConnectedAppMentionOption } from "../../lib/connected-app-mentions";
import type { SandboxActionCatalogEntry } from "../../lib/sandbox-types";

export type ComposerMentionMenuItem =
  | { kind: "app"; app: OpenPondApp }
  | { kind: "connected-app"; app: ConnectedAppMentionOption }
  | { kind: "action"; action: SandboxActionCatalogEntry };

function mentionMenuItemKey(item: ComposerMentionMenuItem): string {
  if (item.kind === "app") return `app:${item.app.id}`;
  if (item.kind === "connected-app") return `connected-app:${item.app.provider}`;
  return `action:${item.action.id}`;
}

function mentionMenuItemLabel(item: ComposerMentionMenuItem): string {
  if (item.kind === "app") return item.app.name;
  if (item.kind === "connected-app") return item.app.label;
  return actionMentionLabel(item.action);
}

function mentionMenuItemDetail(item: ComposerMentionMenuItem): string {
  if (item.kind === "action") return actionMentionDetail(item.action);
  if (item.kind === "connected-app") return item.app.detail;
  const actionNames = item.app.sandboxActionRegistry?.actions.map((action) => action.name) ?? [];
  return actionNames.length > 0
    ? `Actions: ${actionNames.slice(0, 4).join(", ")}${actionNames.length > 4 ? ` +${actionNames.length - 4}` : ""}`
    : item.app.sandboxManifestError
      ? "Manifest registry unavailable"
      : item.app.description || item.app.gitRepo || item.app.id;
}

function mentionMenuIcon(item: ComposerMentionMenuItem) {
  if (item.kind === "app") return <AtSign size={14} />;
  if (item.kind === "connected-app") {
    return (
      <img
        alt=""
        className="composer-provider-mention-icon"
        draggable={false}
        src={connectedAppProviderIconSrc(item.app.provider)}
      />
    );
  }
  return item.action.implementation?.type === "openpond-agent" ? <Bot size={14} /> : <Workflow size={14} />;
}

function connectedAppProviderIconSrc(provider: ConnectedAppMentionOption["provider"]): string {
  if (provider === "slack") return "/connected-apps/slack.svg";
  if (provider === "microsoft_teams") return "/connected-apps/microsoft.svg";
  if (provider === "github") return "/connected-apps/github.svg";
  if (provider === "google") return "/connected-apps/google.svg";
  if (provider === "x") return "/connected-apps/x.svg";
  return "/connected-apps/openpond-mcp.svg";
}

export function ComposerMentionMenu({
  mentionIndex,
  items,
  onSelect,
  onSelectIndex,
  style,
}: {
  mentionIndex: number;
  items: ComposerMentionMenuItem[];
  onSelect: (item: ComposerMentionMenuItem) => void;
  onSelectIndex: (index: number) => void;
  style: CSSProperties;
}) {
  const selectedOptionRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    selectedOptionRef.current?.scrollIntoView({ block: "nearest" });
  }, [items.length, mentionIndex]);

  return (
    <div
      className="composer-project-menu composer-slash-menu composer-mention-menu"
      role="listbox"
      aria-label="OpenPond mentions"
      style={style}
    >
      {items.map((item, index) => {
        const selected = index === mentionIndex;
        return (
          <button
            key={mentionMenuItemKey(item)}
            type="button"
            className={`composer-project-option ${selected ? "selected" : ""}`}
            ref={selected ? selectedOptionRef : undefined}
            role="option"
            aria-selected={selected}
            onMouseEnter={() => onSelectIndex(index)}
            onMouseDown={(event) => {
              event.preventDefault();
              onSelect(item);
            }}
          >
            {mentionMenuIcon(item)}
            <span>
              <strong>{mentionMenuItemLabel(item)}</strong>
              <small>{mentionMenuItemDetail(item)}</small>
            </span>
            {selected ? <Check size={14} /> : <span aria-hidden="true" />}
          </button>
        );
      })}
    </div>
  );
}
