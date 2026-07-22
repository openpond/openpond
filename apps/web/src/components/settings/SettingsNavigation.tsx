import {
  ArrowLeft,
  Bell,
  BookOpenText,
  Bot,
  ChartColumnStacked,
  Code2,
  FileText,
  Lightbulb,
  MessageSquare,
  Monitor,
  HardDrive,
  RadioTower,
  ScrollText,
  SlidersHorizontal,
  SquarePen,
  UserCircle,
  Workflow,
} from "../icons";
import type { LucideIcon } from "../icons";
import type { SettingsSection } from "../../lib/app-models";

type SettingsNavigationItem = {
  section: SettingsSection;
  label: string;
  Icon: LucideIcon;
};

type SettingsNavigationGroup = {
  label?: string;
  items: SettingsNavigationItem[];
};

const SETTINGS_NAVIGATION_GROUPS: SettingsNavigationGroup[] = [
  {
    items: [
      { section: "account", label: "Account", Icon: UserCircle },
      { section: "notifications", label: "Notifications", Icon: Bell },
      { section: "providers", label: "Providers", Icon: MessageSquare },
      { section: "compute", label: "Compute", Icon: Monitor },
      { section: "dataset-storage", label: "Dataset Storage", Icon: HardDrive },
      { section: "usage", label: "Activity", Icon: ChartColumnStacked },
      { section: "defaults", label: "Defaults", Icon: SlidersHorizontal },
    ],
  },
  {
    label: "Harness",
    items: [
      { section: "profile", label: "My Profile", Icon: Bot },
      { section: "skills", label: "Skills", Icon: FileText },
      { section: "goals", label: "Goals", Icon: ScrollText },
      { section: "context", label: "Context", Icon: BookOpenText },
      { section: "insights", label: "Insights", Icon: Lightbulb },
      { section: "training", label: "Training", Icon: Workflow },
      { section: "subagents", label: "Subagents", Icon: Workflow },
    ],
  },
  {
    items: [
      { section: "editor", label: "Editor", Icon: Code2 },
      { section: "remote", label: "Remote", Icon: RadioTower },
      { section: "personalization", label: "Personalization", Icon: SquarePen },
      { section: "diagnostics", label: "Diagnostics", Icon: ScrollText },
    ],
  },
];

export function SettingsNavigation({
  section,
  onBack,
  onSectionChange,
}: {
  section: SettingsSection;
  onBack: () => void;
  onSectionChange: (section: SettingsSection) => void;
}) {
  return (
    <aside className="settings-sidebar">
      <button className="settings-back" onClick={onBack}>
        <ArrowLeft size={15} />
        <span>Back to app</span>
      </button>
      <nav className="settings-nav" aria-label="Settings">
        {SETTINGS_NAVIGATION_GROUPS.map((group, groupIndex) => (
          <div className="settings-nav-group" key={group.label ?? `settings-${groupIndex}`}>
            {group.label ? <div className="settings-nav-heading">{group.label}</div> : null}
            {group.items.map(({ section: itemSection, label, Icon }) => (
              <button
                className={`settings-nav-item ${section === itemSection ? "active" : ""}`}
                key={itemSection}
                onClick={() => onSectionChange(itemSection)}
              >
                <Icon size={16} />
                <span>{label}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>
    </aside>
  );
}
