import type { Experience } from "@openpond/contracts";

const EXPERIENCE_OPTIONS: ReadonlyArray<{
  value: Experience;
  label: string;
  description: string;
}> = [
  {
    value: "chat",
    label: "Chat",
    description: "Ask questions and work conversationally",
  },
  {
    value: "work",
    label: "Work",
    description: "Complete multi-step tasks and create outputs",
  },
  {
    value: "development",
    label: "Development",
    description: "Work with projects, code, and developer tools",
  },
];

export function ExperienceSelector({
  value,
  onChange,
}: {
  value: Experience;
  onChange: (experience: Experience) => void;
}) {
  return (
    <div className="experience-selector" role="group" aria-label="Experience">
      {EXPERIENCE_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          className={value === option.value ? "active" : ""}
          aria-pressed={value === option.value}
          title={option.description}
          onClick={() => {
            if (option.value !== value) onChange(option.value);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
