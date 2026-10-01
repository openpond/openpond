import { useId, useState, type ReactNode } from "react";

const tabs = ["dataset", "target", "graders"] as const;
type Tab = (typeof tabs)[number];
const labels = { dataset: "Dataset", target: "Target", graders: "Graders" };

/** Keep all panes mounted so switching tabs cannot discard edited inputs. */
export function ExperimentSetupTabs(props: Record<Tab, ReactNode>) {
  const [active, setActive] = useState<Tab>("dataset");
  const id = useId();
  return (
    <div className="experiment-setup-tabs">
      <div role="tablist" aria-label="Experiment setup" className="evaluation-workspace-tabs">
        {tabs.map((tab, index) => (
          <button
            key={tab}
            id={`${id}-${tab}-tab`}
            type="button"
            role="tab"
            aria-selected={active === tab}
            aria-controls={`${id}-${tab}-panel`}
            tabIndex={active === tab ? 0 : -1}
            onClick={() => setActive(tab)}
            onKeyDown={(event) => {
              const next =
                event.key === "ArrowRight"
                  ? tabs[(index + 1) % tabs.length]
                  : event.key === "ArrowLeft"
                    ? tabs[(index + tabs.length - 1) % tabs.length]
                    : event.key === "Home"
                      ? tabs[0]
                      : event.key === "End"
                        ? tabs[tabs.length - 1]
                        : null;
              if (!next) return;
              event.preventDefault();
              setActive(next);
              document.getElementById(`${id}-${next}-tab`)?.focus();
            }}
          >
            {labels[tab]}
          </button>
        ))}
      </div>
      {tabs.map((tab) => (
        <section
          key={tab}
          role="tabpanel"
          id={`${id}-${tab}-panel`}
          aria-labelledby={`${id}-${tab}-tab`}
          hidden={active !== tab}
          className="evaluation-setup-pane"
        >
          {props[tab]}
        </section>
      ))}
    </div>
  );
}
