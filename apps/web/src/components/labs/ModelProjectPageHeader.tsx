import type { ReactNode } from "react";

export type ModelProjectPageMetric = {
  label: string;
  value: ReactNode;
  hint?: string;
  ariaLabel?: string;
  onSelect?: () => void;
};

export function ModelProjectPageHeader({
  title,
  description,
  status,
  actions,
  layout = "default",
  metrics = [],
}: {
  title: string;
  description: string;
  status?: ReactNode;
  actions?: ReactNode;
  layout?: "default" | "toolbar";
  metrics?: ModelProjectPageMetric[];
}) {
  return (
    <header className={`model-project-page-header model-project-page-header-${layout}`}>
      <div className="model-project-page-heading">
        <div>
          <div className="model-project-page-title-row">
            <h1>{title}</h1>
            {status}
          </div>
          <p>{description}</p>
        </div>
        {actions ? <div className="model-project-page-actions">{actions}</div> : null}
      </div>
      {metrics.length ? (
        <dl className="model-project-page-metrics">
          {metrics.map((metric) => (
            <div
              key={metric.label}
            >
              <dt>{metric.label}</dt>
              <dd>
                {metric.onSelect ? (
                  <button
                    aria-label={metric.ariaLabel}
                    className="model-project-page-metric-link"
                    type="button"
                    onClick={metric.onSelect}
                  >
                    {metric.value}
                  </button>
                ) : metric.value}
              </dd>
              {metric.hint ? <small>{metric.hint}</small> : null}
            </div>
          ))}
        </dl>
      ) : null}
    </header>
  );
}
