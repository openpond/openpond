import {
  ArrowLeft,
  Bot,
  ChartColumnStacked,
  Code2,
  CreditCard,
  MessageSquare,
  RadioTower,
  ScrollText,
  SlidersHorizontal,
  SquarePen,
  UserCircle,
} from "../icons";
import type { LucideIcon } from "../icons";
import type { SettingsSection } from "../../lib/app-models";

type SettingsNavigationItem = {
  section: SettingsSection;
  label: string;
  Icon: LucideIcon;
};

const SETTINGS_NAVIGATION_ITEMS: SettingsNavigationItem[] = [
  { section: "account", label: "Account", Icon: UserCircle },
  { section: "profile", label: "Profile", Icon: Bot },
  { section: "wallet", label: "Wallet", Icon: CreditCard },
  { section: "defaults", label: "Defaults", Icon: SlidersHorizontal },
  { section: "editor", label: "Editor", Icon: Code2 },
  { section: "providers", label: "Providers", Icon: MessageSquare },
  { section: "remote", label: "Remote", Icon: RadioTower },
  { section: "usage", label: "Usage", Icon: ChartColumnStacked },
  { section: "personalization", label: "Personalization", Icon: SquarePen },
  { section: "diagnostics", label: "Diagnostics", Icon: ScrollText },
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
        {SETTINGS_NAVIGATION_ITEMS.map(({ section: itemSection, label, Icon }) => (
          <button
            className={`settings-nav-item ${section === itemSection ? "active" : ""}`}
            key={itemSection}
            onClick={() => onSectionChange(itemSection)}
          >
            <Icon size={16} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}
