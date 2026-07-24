import type { TrainingCatalog } from "@openpond/contracts";

import type { PortableTrainingMethod } from "./training-start-view-helpers";

type ApprovalPolicy = NonNullable<
  TrainingCatalog["targets"][number]["approvalPolicy"]
>;

export function TrainingProviderApprovalFields({
  approvalPolicy,
  providerLabel,
  method,
  busy,
  exportApproved,
  maximumCostUsd,
  retentionDays,
  onManageProvider,
  onExportApprovedChange,
  onMaximumCostChange,
  onRetentionDaysChange,
}: {
  approvalPolicy: ApprovalPolicy;
  providerLabel: string;
  method: PortableTrainingMethod;
  busy: boolean;
  exportApproved: boolean;
  maximumCostUsd: number | null;
  retentionDays: number;
  onManageProvider?: () => void;
  onExportApprovedChange: (approved: boolean) => void;
  onMaximumCostChange: (maximumCostUsd: number) => void;
  onRetentionDaysChange: (retentionDays: number) => void;
}) {
  return (
    <fieldset className="training-provider-approval">
      <legend>Provider approval</legend>
      {onManageProvider ? (
        <button
          className="training-text-button"
          type="button"
          disabled={busy}
          onClick={onManageProvider}
        >
          {approvalPolicy.settingsActionLabel ?? `Manage ${providerLabel}`}
        </button>
      ) : null}
      <label className="training-provider-consent">
        <input
          type="checkbox"
          checked={exportApproved}
          disabled={busy}
          onChange={(event) =>
            onExportApprovedChange(event.target.checked)
          }
        />
        <span>
          {approvalPolicy.exportDescription ??
            `Export only the approved train split to ${providerLabel}.`}
        </span>
      </label>
      <div className="training-start-fields">
        <label>
          <span>Maximum provider spend (USD)</span>
          <input
            aria-label="Maximum provider spend (USD)"
            type="number"
            min={approvalPolicy.minimumSpendUsd}
            max={approvalPolicy.maximumSpendUsd}
            step={0.01}
            value={maximumCostUsd ?? ""}
            disabled={busy}
            onChange={(event) =>
              onMaximumCostChange(event.target.valueAsNumber)
            }
          />
        </label>
        <label>
          <span>Retention record (days)</span>
          <input
            aria-label="Retention record (days)"
            type="number"
            min={approvalPolicy.minimumRetentionDays}
            max={approvalPolicy.maximumRetentionDays}
            step={1}
            value={retentionDays}
            disabled={busy}
            onChange={(event) =>
              onRetentionDaysChange(event.target.valueAsNumber)
            }
          />
        </label>
      </div>
      <p className="training-start-note">
        Approval is bound server-side to the signed-in OpenPond account at
        launch.
      </p>
      {method === "grpo" ? (
        <p className="training-start-note">
          {approvalPolicy.methodRequirement}
        </p>
      ) : null}
    </fieldset>
  );
}
