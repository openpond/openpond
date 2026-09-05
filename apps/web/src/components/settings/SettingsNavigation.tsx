import {
  ArrowLeft,
  Archive,
  Bell,
  BookOpenText,
  Bot,
  ChartColumnStacked,
  Code2,
  FileText,
  MessageSquare,
  HardDrive,
  RadioTower,
  RefreshCw,
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
      { section: "usage", label: "Activity", Icon: ChartColumnStacked },
    ],
  },
  {
    label: "Harness",
    items: [
      { section: "harness", label: "Overview", Icon: Workflow },
      { section: "harness-refiner", label: "Refiner", Icon: SquarePen },
      { section: "harness-continuous-review", label: "Continuous Review", Icon: RefreshCw },
      { section: "harness-contents", label: "Contents", Icon: BookOpenText },
      { section: "harness-releases", label: "Releases", Icon: Archive },
    ],
  },
  {
    label: "Customization",
    items: [
      { section: "configuration", label: "Configuration", Icon: SlidersHorizontal },
      { section: "personalization", label: "Personalization", Icon: SquarePen },
      { section: "editor", label: "Editor", Icon: Code2 },
      { section: "skills", label: "Skills", Icon: FileText },
    ],
  },
  {
    label: "Agents",
    items: [
      { section: "profile", label: "Profiles", Icon: UserCircle },
      { section: "subagents", label: "Agents", Icon: Bot },
    ],
  },
  {
    label: "System",
    items: [
      { section: "dataset-storage", label: "Dataset Storage", Icon: HardDrive },
      { section: "remote", label: "Remote Access", Icon: RadioTower },
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
      <button className="settings-back" aria-label="Back to app" onClick={onBack}>
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
