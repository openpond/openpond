export type EvaluationComparisonSeries = {
  id: string;
  label: string;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  passRate: number;
  costUsd: number | null;
};

export function EvaluationComparisonCharts({
  series,
}: {
  series: EvaluationComparisonSeries[];
}) {
  const maxTokens = Math.max(1, ...series.map((item) => item.tokens));
  return (
    <div className="labs-evaluation-comparison" aria-label="Evaluation comparison">
      <ComparisonChart
        title="Foreground tokens"
        description="Provider-reported input and output tokens for evaluated tasks."
        direction="Lower is better"
        series={series.map((item) => ({
          id: item.id,
          label: item.label,
          value: item.tokens,
          display: item.tokens.toLocaleString(),
          ratio: item.tokens / maxTokens,
        }))}
      />
      <ComparisonChart
        title="Quality"
        description="Share of evaluated tasks that passed the pinned graders."
        direction="Higher is better"
        series={series.map((item) => ({
          id: item.id,
          label: item.label,
          value: item.passRate,
          display: `${Math.round(item.passRate * 100)}%`,
          ratio: item.passRate,
        }))}
      />
      <TokenMixChart series={series} />
    </div>
  );
}

function TokenMixChart({ series }: { series: EvaluationComparisonSeries[] }) {
  return (
    <section className="labs-evaluation-chart">
      <header>
        <div>
          <h4>Token mix</h4>
          <p>Input and output tokens inside each measured foreground total.</p>
        </div>
        <div className="labs-evaluation-token-legend" aria-label="Token legend">
          <span>Input</span>
          <span>Output</span>
        </div>
      </header>
      <div className="labs-evaluation-token-mix">
        {series.map((item, index) => {
          const total = Math.max(1, item.inputTokens + item.outputTokens);
          return (
            <div data-series-index={index} key={item.id}>
              <div className="labs-evaluation-token-label">
                <span>{item.label}</span>
                <strong>{item.tokens.toLocaleString()}</strong>
              </div>
              <div className="labs-evaluation-token-stack" aria-hidden="true">
                <span style={{ width: `${(item.inputTokens / total) * 100}%` }} />
                <span style={{ width: `${(item.outputTokens / total) * 100}%` }} />
              </div>
              <small>
                {item.inputTokens.toLocaleString()} input · {item.outputTokens.toLocaleString()} output
              </small>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ComparisonChart({
  title,
  description,
  direction,
  series,
}: {
  title: string;
  description: string;
  direction: string;
  series: Array<{
    id: string;
    label: string;
    value: number;
    display: string;
    ratio: number;
  }>;
}) {
  return (
    <section className="labs-evaluation-chart">
      <header>
        <div>
          <h4>{title}</h4>
          <p>{description}</p>
        </div>
        <span className="labs-evaluation-direction">{direction}</span>
      </header>
      <div className="labs-evaluation-chart-series">
        {series.map((item, index) => (
          <div
            className="labs-evaluation-chart-row"
            data-series-index={index}
            key={item.id}
          >
            <div className="labs-evaluation-chart-label">
              <span>{item.label}</span>
              <strong>{item.display}</strong>
            </div>
            <div className="labs-evaluation-chart-track" aria-hidden="true">
              <span
                style={{ width: `${Math.max(2, Math.min(100, item.ratio * 100))}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
