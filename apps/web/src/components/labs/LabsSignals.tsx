import { useState } from "react";
import { InsightsView, type InsightsViewProps } from "../insights/InsightsView";
import { TrainingView, type TrainingViewProps } from "../training/TrainingView";

type SignalView = "observations" | "suggestions";

export function LabsSignals({
  insights,
  training,
  onOpenLabsSection,
}: {
  insights: InsightsViewProps;
  training: Omit<TrainingViewProps, "section" | "onSectionChange">;
  onOpenLabsSection: (section: "models" | "evals") => void;
}) {
  const [view, setView] = useState<SignalView>("observations");
  const observationCount = insights.items.filter((item) => item.status === "active").length;
  const suggestionCount = training.training.payload?.candidates.length ?? 0;

  return (
    <section className="labs-signals" aria-label="Signals">
      <div className="labs-subtabs" role="tablist" aria-label="Signal types">
        <button
          aria-selected={view === "observations"}
          className={view === "observations" ? "active" : undefined}
          role="tab"
          type="button"
          onClick={() => setView("observations")}
        >
          Observations <span>{observationCount}</span>
        </button>
        <button
          aria-selected={view === "suggestions"}
          className={view === "suggestions" ? "active" : undefined}
          role="tab"
          type="button"
          onClick={() => setView("suggestions")}
        >
          AI Suggestions <span>{suggestionCount}</span>
        </button>
      </div>
      {view === "observations" ? (
        <InsightsView {...insights} />
      ) : (
        <TrainingView
          {...training}
          section="suggestions"
          onSectionChange={onOpenLabsSection}
        />
      )}
    </section>
  );
}
