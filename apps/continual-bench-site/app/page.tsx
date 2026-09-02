import { CONTINUAL_BENCH_COMMANDS } from "@openpond/continual-bench";
import Link from "next/link";

const HOW_TOS = [
  { href: "/convert-a-test-set/", number: "01", title: "Convert a test set", summary: "Group canonical issue families, reserve sibling and retention panels, then seal the split before inspecting results." },
  { href: "/run-continual-evaluation/", number: "02", title: "Run continual evaluation", summary: "Train only reviewed correction cases and evaluate every candidate against the same immutable panels." },
  { href: "/read-the-scorecard/", number: "03", title: "Read the scorecard", summary: "Separate acquisition, generalization, retention, frontier quality, and efficiency from the operator decision." },
] as const;

export default function HomePage() {
  return (
    <div className="home-shell">
      <div className="hero">
        <h1>Continual Bench</h1>
        <p className="subtitle">A benchmark for models that need to keep learning.</p>
        <p className="lede">Turn ordinary test sets into sealed correction, sibling, retention, and frozen panels—then compare every update with matched evidence.</p>
        <div className="primary-links" aria-label="Project links">
          <a href="https://github.com/openpond/openpond">GitHub</a>
          <a href="/example-taskset.json">Example Taskset</a>
          <a href="https://openpond.ai">OpenPond</a>
        </div>
        <code className="get-started">{CONTINUAL_BENCH_COMMANDS.init}</code>
      </div>
      <div className="how-to-grid" aria-label="How-to guides">
        {HOW_TOS.map((guide) => (
          <Link className="how-to-card" href={guide.href} key={guide.href}>
            <span className="card-number">{guide.number}</span>
            <h2>{guide.title}</h2>
            <p>{guide.summary}</p>
            <span className="card-link">Read the guide <span aria-hidden="true">→</span></span>
          </Link>
        ))}
      </div>
    </div>
  );
}
