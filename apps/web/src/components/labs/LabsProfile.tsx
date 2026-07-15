import type { InsightItem } from "@openpond/contracts";
import type { useTraining } from "../../hooks/useTraining";
import type { LabsTab } from "../../lib/app-models";
import { ArrowRight, Bot, Boxes, ChartColumnStacked, Lightbulb, Workflow } from "../icons";
import { ProfileView, type ProfileViewProps } from "../profile/ProfileView";

type TrainingController = ReturnType<typeof useTraining>;
type SummaryCard = {
  id: Exclude<LabsTab, "profile">;
  label: string;
  value: string;
  detail: string;
  tone?: "warning" | "muted";
  Icon: typeof Bot;
};

export function LabsProfile({
  insightsError,
  insightsEnabled,
  insightsItems,
  insightsScanning,
  onTabChange,
  profileView,
  training,
}: {
  insightsError: string | null;
  insightsEnabled: boolean;
  insightsItems: InsightItem[];
  insightsScanning: boolean;
  onTabChange: (tab: LabsTab) => void;
  profileView: ProfileViewProps;
  training: TrainingController;
}) {
  const payload = profileView.payload;
  const profile = payload?.profile ?? null;
  const trainingState = training.payload;
  const activeSignals = insightsItems.filter((item) => item.status === "active").length;
  const candidateCount = trainingState?.candidates.length ?? 0;
  const cards: SummaryCard[] = [
    {
      id: "signals",
      label: "Signals",
      value: !insightsEnabled ? "Off" : insightsScanning ? "Scanning" : String(activeSignals + candidateCount),
      detail: insightsEnabled
        ? `${activeSignals} active observations · ${candidateCount} AI suggestions`
        : "Turn on observation scanning in Signals",
      tone: insightsError ? "warning" : undefined,
      Icon: Lightbulb,
    },
    {
      id: "evals",
      label: "Evals",
      value: training.loading && !trainingState ? "Loading" : String(trainingState?.tasksets.length ?? 0),
      detail: trainingState ? `${trainingState.baselineReports.length} baseline reports` : "No Tasksets loaded",
      tone: training.error ? "warning" : undefined,
      Icon: Workflow,
    },
    {
      id: "models",
      label: "Models",
      value: training.loading && !trainingState ? "Loading" : String(trainingState?.models.length ?? 0),
      detail: trainingState ? `${trainingState.jobs.length} training jobs · ${trainingState.artifacts.length} artifacts` : "No training state loaded",
      tone: training.error ? "warning" : undefined,
      Icon: ChartColumnStacked,
    },
    {
      id: "agents",
      label: "Agents",
      value: profile?.mode === "local" ? String(profile.agents.length) : "—",
      detail: profile?.mode === "local"
        ? `${profile.actionCatalog.length} available action${profile.actionCatalog.length === 1 ? "" : "s"}`
        : "Load a Profile to see agents",
      Icon: Bot,
    },
    {
      id: "extensions",
      label: "Extensions",
      value: "Not available yet",
      detail: "The extension catalog and runtime arrive in the focused extension phase",
      tone: "muted",
      Icon: Boxes,
    },
  ];
  return (
    <div className="labs-profile">
      <ProfileView
        {...profileView}
        overviewContent={(
          <section className="labs-summary-grid" aria-label="Profile system summary">
            {cards.map(({ Icon, ...card }) => (
              <button
                className={`labs-summary-card${card.tone ? ` ${card.tone}` : ""}`}
                key={card.id}
                type="button"
                onClick={() => onTabChange(card.id)}
              >
                <span className="labs-summary-card-icon"><Icon size={17} /></span>
                <span className="labs-summary-card-copy">
                  <span>{card.label}</span>
                  <strong>{card.value}</strong>
                  <small>{card.detail}</small>
                </span>
                <ArrowRight className="labs-summary-card-arrow" size={15} />
              </button>
            ))}
          </section>
        )}
        section="all"
      />
    </div>
  );
}
