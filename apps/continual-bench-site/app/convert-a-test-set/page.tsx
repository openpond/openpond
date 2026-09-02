import { CONTINUAL_BENCH_COMMANDS } from "@openpond/continual-bench";
import type { Metadata } from "next";

import fixtureManifest from "../../../../examples/tau3-retail-continual-v1/continual-bench.json";
import { CodeBlock, GuidePage } from "../_components/GuidePage";

export const metadata: Metadata = {
  title: "Convert a test set",
  description: "A complete family-level workflow for converting an ordinary test set into a sealed continual-learning benchmark.",
};

const STEPS = [
  ["Identify canonical issue families", "Group rows by the underlying failure mechanism or shared entity ownership. Random row shuffles can put near-identical cases on both sides of a holdout."],
  ["Choose reviewed correction cases", "Select the cases that may become optimizer evidence. Human review records why each case is included, deferred, or excluded."],
  ["Reserve undisclosed siblings", "Keep other cases from the same family hidden from the Policy. They test whether the correction generalized beyond the exact row."],
  ["Reserve stable and frozen panels", "Use disjoint issue families for development and behavioral retention. Open the frozen-final panel once, after the sequence is complete."],
  ["Sequence families into passes", "Assign whole families to ordered passes. Future siblings remain unavailable while earlier corrections are trained."],
  ["Run four leakage checks", "Reject duplicate IDs, duplicate content, forbidden family overlap, semantic near-duplicates, and any task already exposed to a prior optimizer or evaluation."],
  ["Seal the protocol", "Hash the task inventory, split, grader, prompt and tools, harness, seeds, repetitions, thresholds, and resource ceilings before inspecting candidates."],
] as const;

export default function ConvertPage() {
  return (
    <GuidePage number="01" title="Convert a test set" intro="A continual benchmark begins with family structure, not a random train/test split." next={{ href: "/run-continual-evaluation/", label: "Run continual evaluation" }}>
      <section>
        <h2>Start from labeled JSON or JSONL</h2>
        <p>Each row needs a stable task ID, a canonical <code>familyId</code>, and a pass label. Mark disjoint development, retained, and frozen rows with <code>panelRole</code>. If labels are absent, the initializer asks for them interactively; CI mode fails rather than inventing a family.</p>
        <CodeBlock>{`${CONTINUAL_BENCH_COMMANDS.init} \\\n+  --output ./continual-bench.yaml \\\n+  --non-interactive\n${CONTINUAL_BENCH_COMMANDS.validate}`}</CodeBlock>
      </section>
      <section>
        <h2>The seven conversion decisions</h2>
        <ol className="decision-list">
          {STEPS.map(([title, explanation]) => <li key={title}><h3>{title}</h3><p>{explanation}</p></li>)}
        </ol>
      </section>
      <section>
        <h2>What the fixture seals</h2>
        <dl className="facts-grid">
          <div><dt>Manifest</dt><dd>{fixtureManifest.contentHash}</dd></div>
          <div><dt>Split seed</dt><dd>{fixtureManifest.split.seed}</dd></div>
          <div><dt>Passes</dt><dd>{fixtureManifest.passes.length}</dd></div>
          <div><dt>Task rows</dt><dd>{fixtureManifest.tasks.length}</dd></div>
          <div><dt>Repetitions</dt><dd>{fixtureManifest.evaluation.repetitions}</dd></div>
          <div><dt>Confidence</dt><dd>{Math.round(fixtureManifest.evaluation.confidenceLevel * 100)}%</dd></div>
        </dl>
        <p>The converter can recommend a split and report insufficient siblings. It never fabricates rows or silently shrinks a holdout.</p>
      </section>
    </GuidePage>
  );
}
