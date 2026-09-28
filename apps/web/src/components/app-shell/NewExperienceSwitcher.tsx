import type { KeyboardEvent } from "react";
import {
  CHAT_TASK_MODE_OPTIONS,
  type ChatTaskMode,
} from "../../lib/experience-options";

export function NewExperienceSwitcher({
  value,
  onChange,
  allowPonder = false,
}: {
  value: ChatTaskMode | "ponder";
  onChange: (experience: ChatTaskMode | "ponder") => void;
  allowPonder?: boolean;
}) {
  const modeOptions = allowPonder
    ? [{ value: "ponder" as const, label: "Ponder Pal" }, ...CHAT_TASK_MODE_OPTIONS]
    : CHAT_TASK_MODE_OPTIONS;
  const selectAdjacentExperience = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentIndex: number
  ) => {
    let nextIndex: number;
    if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = modeOptions.length - 1;
    } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % modeOptions.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex =
        (currentIndex - 1 + modeOptions.length) % modeOptions.length;
    } else {
      return;
    }

    event.preventDefault();
    const nextExperience = modeOptions[nextIndex];
    if (!nextExperience) return;

    onChange(nextExperience.value);
    const options =
      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
        ".new-experience-option"
      );
    options?.[nextIndex]?.focus();
  };

  return (
    <div
      className="new-experience-switcher"
      role="radiogroup"
      aria-label="Choose task mode"
    >
      {modeOptions.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            className={`new-experience-option ${selected ? "active" : ""}`}
            data-experience={option.value}
            tabIndex={selected ? 0 : -1}
            onClick={() => {
              if (!selected) onChange(option.value);
            }}
            onKeyDown={(event) => selectAdjacentExperience(event, index)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
