import type { BootstrapPayload } from "@openpond/contracts";
import type { ClientConnection } from "../../api";
import "../../styles/settings/settings-layout.css";
import "../../styles/settings/settings-forms.css";
import "../../styles/settings/settings-lists.css";
import { ProfileSettingsSection } from "../settings/ProfileSettingsSection";

export function ProfileView({
  payload,
  connection,
  onPayload,
  onError,
  onToast,
  onSkillCommand,
}: {
  payload: BootstrapPayload | null;
  connection: ClientConnection | null;
  onPayload: (payload: BootstrapPayload) => void;
  onError: (message: string | null) => void;
  onToast?: (message: string, tone?: "success" | "error" | "info") => void;
  onSkillCommand?: (command: string) => void;
}) {
  return (
    <section className="profile-view" aria-label="Profile">
      <ProfileSettingsSection
        payload={payload}
        connection={connection}
        onPayload={onPayload}
        onError={onError}
        onToast={onToast}
        onSkillCommand={onSkillCommand}
      />
    </section>
  );
}
