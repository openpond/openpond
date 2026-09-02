import Link from "next/link";
import type { ReactNode } from "react";

export function GuidePage({
  number,
  title,
  intro,
  children,
  next,
}: {
  number: string;
  title: string;
  intro: string;
  children: ReactNode;
  next: { href: string; label: string };
}) {
  return (
    <article className="guide-shell">
      <header className="guide-heading">
        <span aria-hidden="true">{number}</span>
        <h1>{title}</h1>
        <p>{intro}</p>
      </header>
      <div className="guide-content">{children}</div>
      <Link className="next-guide" href={next.href}>Next: {next.label} <span aria-hidden="true">→</span></Link>
    </article>
  );
}

export function CodeBlock({ children }: { children: string }) {
  return <pre tabIndex={0}><code>{children}</code></pre>;
}
