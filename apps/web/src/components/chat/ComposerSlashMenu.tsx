import type { CSSProperties } from "react";
import {
  ComposerCommandMenu,
  type SlashMenuItem,
} from "./ComposerCommandMenu";

export type { SlashMenuItem } from "./ComposerCommandMenu";

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
  return (
    <ComposerCommandMenu
      ariaLabel="OpenPond agents and actions"
      menuIndex={actionIndex}
      sections={[{
        emptyLabel: actionCatalogCount === 0
          ? "No matching commands or apps"
          : "No matching commands, apps, agents, or actions",
        id: "slash",
        items: items.map((item) => ({ kind: "slash", item })),
        label: "/",
      }]}
      style={style}
      variant="typed"
      onSelect={(item) => {
        if (item.kind === "slash") onSelect(item.item);
      }}
      onSelectIndex={onSelectIndex}
    />
  );
}
