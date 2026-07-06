import type { CSSProperties } from "react";
import { useEffect, useRef } from "react";
import type { OpenPondProfileSkill } from "@openpond/contracts";
import { Check, FileText } from "../icons";
import { profileSkillInvocationText } from "../../lib/profile-skill-invocations";

export type ComposerSkillMenuItem = OpenPondProfileSkill;

function skillMenuDetail(skill: ComposerSkillMenuItem): string {
  return skill.description || skill.path;
}

export function ComposerSkillMenu({
  items,
  onSelect,
  onSelectIndex,
  skillIndex,
  style,
}: {
  items: ComposerSkillMenuItem[];
  onSelect: (item: ComposerSkillMenuItem) => void;
  onSelectIndex: (index: number) => void;
  skillIndex: number;
  style: CSSProperties;
}) {
  const selectedOptionRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    selectedOptionRef.current?.scrollIntoView({ block: "nearest" });
  }, [items.length, skillIndex]);

  return (
    <div
      className="composer-project-menu composer-slash-menu composer-skill-menu"
      role="listbox"
      aria-label="OpenPond profile skills"
      style={style}
    >
      {items.length > 0 ? (
        items.map((item, index) => {
          const selected = index === skillIndex;
          return (
            <button
              key={item.name}
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
              <FileText size={14} />
              <span>
                <strong>{profileSkillInvocationText(item)}</strong>
                <small>{skillMenuDetail(item)}</small>
              </span>
              {selected ? <Check size={14} /> : <span aria-hidden="true" />}
            </button>
          );
        })
      ) : (
        <div className="composer-menu-empty" role="option" aria-selected="false">
          No matching profile skills
        </div>
      )}
    </div>
  );
}
