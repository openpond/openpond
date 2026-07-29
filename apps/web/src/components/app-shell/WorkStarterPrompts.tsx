import type { LucideIcon } from "../icons";
import { ChartColumnStacked, FileText, Lightbulb, Search } from "../icons";

export const WORK_STARTER_PROMPTS: ReadonlyArray<{
  label: string;
  prompt: string;
  icon: LucideIcon;
}> = [
  {
    label: "Turn notes into a polished report",
    prompt:
      "Turn my notes and attached source material into a polished report. Organize the key findings, identify missing information, and return a draft for my review.",
    icon: FileText,
  },
  {
    label: "Analyze a spreadsheet",
    prompt:
      "Analyze the attached spreadsheet. Check the calculations, summarize the most important findings, flag anomalies or missing data, and create a reviewable results file.",
    icon: ChartColumnStacked,
  },
  {
    label: "Research options and recommend one",
    prompt:
      "Research the best options for this decision. Compare the most important criteria, cite the sources, flag uncertainty, and return a recommendation with next steps.",
    icon: Search,
  },
  {
    label: "Create a presentation from source material",
    prompt:
      "Create a concise presentation from my attached source material. Focus on the main themes and supporting evidence, separate findings from recommendations, and return a draft for my review.",
    icon: Lightbulb,
  },
];

export function WorkStarterPrompts({
  onSelect,
}: {
  onSelect: (prompt: string) => void;
}) {
  return (
    <div className="work-starter-prompts" aria-label="Work task examples">
      {WORK_STARTER_PROMPTS.map(({ icon: Icon, label, prompt }) => (
        <button
          key={label}
          type="button"
          className="work-starter-prompt"
          onClick={() => onSelect(prompt)}
        >
          <Icon size={15} aria-hidden="true" />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}
