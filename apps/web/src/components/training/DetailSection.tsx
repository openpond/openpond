import type { ReactNode } from "react";

export function DetailSection({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="training-detail-section">
      <div className="training-detail-section-heading">
        <h2>{title}</h2>
        {actions ? <div>{actions}</div> : null}
      </div>
      <div className="training-detail-section-panel">{children}</div>
    </section>
  );
}
