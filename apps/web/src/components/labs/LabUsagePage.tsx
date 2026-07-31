import type { AccountState } from "@openpond/contracts";

import type { ClientConnection } from "../../api";
import { UsageSettingsSection } from "../settings/UsageSettingsSection";

export function LabUsagePage({
  account,
  connection,
  onError,
  onOpenSourceSession,
}: {
  account: AccountState | null;
  connection: ClientConnection | null;
  onError: (message: string | null) => void;
  onOpenSourceSession: (sessionId: string) => void;
}) {
  return (
    <div className="labs-flat-body labs-usage-page">
      <header className="labs-operational-header">
        <h2>Model usage</h2>
        <p>
          All recorded model calls for this account. Narrow the projection by
          provider, model, status, visibility, or time range.
        </p>
      </header>
      <UsageSettingsSection
        account={account}
        connection={connection}
        enabled
        modelFocused
        onError={onError}
        onOpenSourceSession={onOpenSourceSession}
      />
    </div>
  );
}
