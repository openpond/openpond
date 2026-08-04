import { useState } from "react";
import {
  LocalConversationLearningConsentSchema,
  type Session,
} from "@openpond/contracts";

import { api, type ClientConnection } from "../../api";

export function LocalConversationLearningConsentControl({
  connection,
  session,
  onUpdated,
}: {
  connection: ClientConnection | null;
  session: Session | null;
  onUpdated: (session: Session) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!session || session.metadata?.continuousLearning) return null;
  const consent = LocalConversationLearningConsentSchema.safeParse(
    session.metadata?.continuousLearningConsent,
  ).data ?? null;
  const granted = consent?.status === "granted";
  const scope = session.cloudTeamId ? "my_team" : "personal";

  async function toggle() {
    if (!connection || busy || !session) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.setLocalConversationLearningConsent(
        connection,
        session.id,
        {
          status: granted ? "revoked" : "granted",
          scope,
          workspaceId: session.cloudTeamId ?? null,
        },
      );
      onUpdated(result.session);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="chat-learning-consent">
      <div>
        <strong>{granted ? "Eligible for Models review" : "Not used for Models review"}</strong>
        <span>
          {granted
            ? `This ${scope === "my_team" ? "Team" : "Personal"} conversation may be included in future local reviews.`
            : "A schedule cannot use this conversation unless you allow it here."}
        </span>
        {error ? <span className="chat-learning-consent-error" role="alert">{error}</span> : null}
      </div>
      <button
        className="settings-secondary compact"
        disabled={!connection || busy}
        type="button"
        onClick={() => void toggle()}
      >
        {busy ? "Saving…" : granted ? "Stop using" : "Allow review"}
      </button>
    </div>
  );
}
