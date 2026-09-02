import { CONTINUAL_BENCH_COMMANDS } from "@openpond/continual-bench";
import type { Metadata } from "next";

import fixtureManifest from "../../../../examples/tau3-retail-continual-v1/continual-bench.json";
import { CodeBlock, GuidePage } from "../_components/GuidePage";

export const metadata: Metadata = {
  title: "Run continual evaluation",
  description: "Run a sealed continual-learning sequence while preserving hidden siblings and the normal OpenPond lifecycle.",
};

export default function RunPage() {
  const rows = fixtureManifest.panels.filter((panel) => ["correction", "sibling_verification", "development", "retained", "frozen_final"].includes(panel.role));
  return (
    <GuidePage number="02" title="Run continual evaluation" intro="A run consumes the sealed protocol without turning validation into an upload or a hidden start action." next={{ href: "/read-the-scorecard/", label: "Read the scorecard" }}>
      <section>
        <h2>Validate, create, then decide when to start</h2>
        <CodeBlock>{`${CONTINUAL_BENCH_COMMANDS.validate}\n${CONTINUAL_BENCH_COMMANDS.run}`}</CodeBlock>
        <p><code>validate</code> reads local files only. <code>run</code> submits the sealed protocol to the configured adapter, creates and seals the ordinary Comparison Series, returns its canonical URL, and stops. Queueing a reviewed release and starting its training Run remain separate operator actions.</p>
      </section>
      <section>
        <h2>Disclosure stays phase-bound</h2>
        <div className="table-scroll" tabIndex={0}>
          <table>
            <thead><tr><th>Panel</th><th>Role</th><th>Available</th><th>Optimizer</th><th>Rows</th></tr></thead>
            <tbody>{rows.map((panel) => <tr key={panel.id}><td>{panel.id}</td><td>{panel.role.replaceAll("_", " ")}</td><td>{panel.disclosurePhase}</td><td>{panel.optimizerEligible ? "eligible" : "never"}</td><td>{panel.taskIds.length}</td></tr>)}</tbody>
          </table>
        </div>
        <p>Sibling rows can be public in a reproducibility fixture and still remain unavailable to the Policy process until evaluation. Frozen-final rows stay closed until the final phase.</p>
      </section>
      <section>
        <h2>Use one lifecycle</h2>
        <ol>
          <li>Human Review records exact case dispositions and notes against a sealed issue packet.</li>
          <li>Queue release materializes the immutable correction Taskset but does not start compute.</li>
          <li>Start training creates the normal Plan, Model Run, Job, and Model Version lineage.</li>
          <li>Evaluation Runs use the same panel, grader, seed, repetition, and harness identities for every target.</li>
          <li>An explicit decision may advance the accepted head; evidence never promotes Master by itself.</li>
        </ol>
      </section>
      <section>
        <h2>Adapters remain portable</h2>
        <p>The package adapter interface exposes <code>validate</code>, <code>run</code>, and <code>report</code>. OpenPond is the first full backend, but the manifest does not contain provider credentials, hosting policy, or private deployment details. Another runner can implement the same interface and preserve the disclosure contract.</p>
      </section>
    </GuidePage>
  );
}
