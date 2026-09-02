import { CONTINUAL_BENCH_COMMANDS, ContinualBenchPortableReportSchema } from "@openpond/continual-bench";
import type { Metadata } from "next";

import fixtureReportValue from "../../../../examples/tau3-retail-continual-v1/fixture-report.json";
import { CodeBlock, GuidePage } from "../_components/GuidePage";

export const metadata: Metadata = {
  title: "Read the scorecard",
  description: "Interpret acquisition, sibling generalization, retention, frontier quality, confidence, and efficiency in a Continual Bench report.",
};

const report = ContinualBenchPortableReportSchema.parse(fixtureReportValue);

export default function ScorecardPage() {
  const scored = report.points.filter((point) => point.meanScore !== null);
  return (
    <GuidePage number="03" title="Read the scorecard" intro="The scorecard is a receipt-derived evidence projection. It is not an automatic accept, reject, or production decision." next={{ href: "/", label: "Get started" }}>
      <section>
        <h2>A fixture-derived quality path</h2>
        <div className="score-chart" role="img" aria-label="Fixture strict success rises from 50 percent for the original base to 83 percent at P2. Confidence intervals are shown beneath each point.">
          {scored.map((point) => <div className="chart-column" key={point.id}>
            <div className="chart-track"><span className={`chart-value ${point.kind}`} style={{ height: `${point.meanScore! * 100}%` }}><i /></span></div>
            <strong>{Math.round(point.meanScore! * 100)}</strong>
            <span>{point.label}</span>
            <small>{point.confidenceInterval ? `${Math.round(point.confidenceInterval[0] * 100)}–${Math.round(point.confidenceInterval[1] * 100)}% CI` : "CI unavailable"}</small>
          </div>)}
        </div>
        <p className="fixture-note">Illustrative fixture data generated from <code>fixture-report.json</code>; not a model claim or official Tau3 result.</p>
      </section>
      <section>
        <h2>Read five questions separately</h2>
        <dl className="metric-list">
          <div><dt>Acquisition</dt><dd>Did the candidate solve the reviewed correction cases for the current pass?</dd></div>
          <div><dt>Generalization</dt><dd>Did it also solve undisclosed sibling cases from the same issue families?</dd></div>
          <div><dt>Retention</dt><dd>Did stable retained behavior remain within the sealed regression threshold?</dd></div>
          <div><dt>Frontier quality</dt><dd>How did strict outcomes and a calibrated, blinded judge compare with base, Master, and external references?</dd></div>
          <div><dt>Efficiency</dt><dd>What GPU time, provider spend, latency, groups, and trajectories bought the observed change?</dd></div>
        </dl>
      </section>
      <section>
        <h2>Confidence and missing evidence</h2>
        <p>Task attempts are paired by task, seed, and repetition. Reports include confidence intervals, a paired bootstrap, win/tie/loss counts, and an exact paired binary or sign test where appropriate. A missing panel stays unavailable; it never becomes a zero or a pass.</p>
        <p>Outcome labels are bounded: systems complete, correction absorbed, issue generalized, continually current, frontier Pareto result, inconclusive, or loss. An operator reviews that evidence separately before accepting a head or promoting Master.</p>
        <CodeBlock>{CONTINUAL_BENCH_COMMANDS.report}</CodeBlock>
      </section>
      <section>
        <h2>Reproduce every point</h2>
        <p>Each point links back to its exact Model Version, Taskset release, Evaluation Run, attempts, grader and judge outputs, transcript, tool trace, resource receipt, and immutable protocol identity. The portable JSON export uses the same point and chart data shown in the product.</p>
      </section>
    </GuidePage>
  );
}
