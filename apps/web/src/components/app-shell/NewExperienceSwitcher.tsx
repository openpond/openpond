import type { Experience } from "@openpond/contracts";
import type { KeyboardEvent } from "react";
import { EXPERIENCE_OPTIONS } from "../../lib/experience-options";

export function NewExperienceSwitcher({
  value,
  onChange,
}: {
  value: Experience;
  onChange: (experience: Experience) => void;
}) {
  const selectAdjacentExperience = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentIndex: number
  ) => {
    let nextIndex: number;
    if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = EXPERIENCE_OPTIONS.length - 1;
    } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % EXPERIENCE_OPTIONS.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex =
        (currentIndex - 1 + EXPERIENCE_OPTIONS.length) %
        EXPERIENCE_OPTIONS.length;
    } else {
      return;
    }

    event.preventDefault();
    const nextExperience = EXPERIENCE_OPTIONS[nextIndex];
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
      aria-label="Choose experience"
    >
      {EXPERIENCE_OPTIONS.map((option, index) => {
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
