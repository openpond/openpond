import type { BootstrapPayload, ChatProvider } from "@openpond/contracts";
import type { ReactNode } from "react";
import type { ClientConnection } from "../../api";
import "../../styles/settings/settings-layout.css";
import "../../styles/settings/settings-forms.css";
import "../../styles/settings/settings-lists.css";
import { ProfileSettingsSection } from "../settings/ProfileSettingsSection";

export type ProfileViewSection = "profile" | "agents" | "controls" | "all";

export type ProfileViewProps = {
  section?: ProfileViewSection;
  payload: BootstrapPayload | null;
  connection: ClientConnection | null;
  onPayload: (payload: BootstrapPayload) => void;
  onError: (message: string | null) => void;
  onToast?: (message: string, tone?: "success" | "error" | "info") => void;
  onSkillCommand?: (command: string, provider?: ChatProvider) => void;
  overviewContent?: ReactNode;
};

export function ProfileView({
  section = "all",
  payload,
  connection,
  onPayload,
  onError,
  onToast,
  onSkillCommand,
  overviewContent,
}: ProfileViewProps) {
  return (
    <section className="profile-view" aria-label={section === "agents" ? "Agents" : "Profile"}>
      <ProfileSettingsSection
        section={section}
        payload={payload}
        connection={connection}
        onPayload={onPayload}
        onError={onError}
        onToast={onToast}
        onSkillCommand={onSkillCommand}
        overviewContent={overviewContent}
      />
    </section>
  );
}
