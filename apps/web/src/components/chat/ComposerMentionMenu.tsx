import type { CSSProperties } from "react";
import {
  ComposerCommandMenu,
  type ComposerMentionMenuItem,
} from "./ComposerCommandMenu";

export type { ComposerMentionMenuItem } from "./ComposerCommandMenu";

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
  return (
    <ComposerCommandMenu
      ariaLabel="Mentions"
      className="composer-mention-menu"
      menuIndex={mentionIndex}
      sections={[{
        emptyLabel: "No matching mentions",
        id: "mentions",
        items: items.map((item) => ({ kind: "mention", item })),
        label: "@",
      }]}
      style={style}
      variant="typed"
      onSelect={(item) => {
        if (item.kind === "mention") onSelect(item.item);
      }}
      onSelectIndex={onSelectIndex}
    />
  );
}
