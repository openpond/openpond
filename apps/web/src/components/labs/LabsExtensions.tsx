import { Boxes } from "../icons";

export function LabsExtensions() {
  return (
    <section className="labs-placeholder" aria-label="Extensions unavailable">
      <span className="labs-placeholder-icon"><Boxes size={24} /></span>
      <h2>Your mutable harness modules will live here</h2>
      <p>
        The tab is mounted now so Lab has a stable home for extensions. Catalog discovery,
        compatibility, bindings, activation, and rollback are not available yet.
      </p>
      <div className="labs-placeholder-status">
        <span />
        Extension runtime unavailable
      </div>
    </section>
  );
}
