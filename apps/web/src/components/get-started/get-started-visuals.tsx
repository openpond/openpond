import type { ReactNode } from "react";
import { CheckCircle2, GitBranch, Shield, Workflow } from "../icons";
import type { GetStartedAccent, GetStartedVisualKind } from "./get-started-content";

type GetStartedVisualProps = {
  kind: GetStartedVisualKind;
  accent: GetStartedAccent;
};

export function GetStartedVisual({ accent, kind }: GetStartedVisualProps) {
  switch (kind) {
    case "goal-state":
      return (
        <VisualShell accent={accent}>
          <div className="get-started-dual-goal">
            <GoalCard title="Local goal" detail="session state" status="active" />
            <GoalCard title="Hosted goal" detail="work item state" status="running" />
            <div className="get-started-shared-state">
              <Workflow size={17} />
              <span>objective + evidence + blockers + completion</span>
            </div>
          </div>
        </VisualShell>
      );
    case "goal-evidence":
      return (
        <VisualShell accent={accent}>
          <FlowList
            items={[
              ["Prompt", "objective captured"],
              ["Tools", "files, shell, apps"],
              ["Events", "checks and logs"],
              ["Review", "approval state"],
            ]}
          />
        </VisualShell>
      );
    case "goal-controls":
      return (
        <VisualShell accent={accent}>
          <StatusRail
            rows={[
              ["active", "next continuation allowed"],
              ["paused", "user stopped the loop"],
              ["blocked", "needs input or setup"],
              ["complete", "evidence-backed finish"],
            ]}
          />
        </VisualShell>
      );
    case "goal-context":
      return (
        <VisualShell accent={accent}>
          <ResourceList
            heading="goal context"
            rows={["messages", "workspace files", "check output", "approval notes"]}
          />
        </VisualShell>
      );
    case "create-plan":
      return (
        <VisualShell accent={accent}>
          <FlowList
            items={[
              ["Ask", "short user request"],
              ["Question", "focused follow-up"],
              ["Plan", "agent/action shape"],
              ["Approve", "source may change"],
            ]}
          />
        </VisualShell>
      );
    case "source-tree":
      return (
        <VisualShell accent={accent}>
          <SourceTree
            heading="profiles/default"
            rows={["agent/agent.ts", "agent/actions/*", "agent/evals/*", ".openpond/action-registry.json"]}
          />
        </VisualShell>
      );
    case "check-stack":
      return (
        <VisualShell accent={accent}>
          <StatusRail
            rows={[
              ["inspect", "passed"],
              ["build", "passed"],
              ["validate", "passed"],
              ["eval", "setup gate ready"],
            ]}
          />
        </VisualShell>
      );
    case "catalog":
      return (
        <VisualShell accent={accent}>
          <ResourceList
            heading="profile action catalog"
            rows={["default.chat", "support.open-items", "release-notes.generate", "setup status: ready"]}
          />
        </VisualShell>
      );
    case "edit-review":
      return (
        <VisualShell accent={accent}>
          <DiffReview />
        </VisualShell>
      );
    case "profile-source":
      return (
        <VisualShell accent={accent}>
          <SourceTree
            heading="openpond-profile"
            rows={["openpond-profile.json", "profiles/default/settings/profile.yaml", "profiles/default/agent", ".openpond/artifact-index.json"]}
          />
        </VisualShell>
      );
    case "profile-sync":
      return (
        <VisualShell accent={accent}>
          <FlowList
            items={[
              ["Local profile", "source + checks"],
              ["Push", "hosted source ref"],
              ["Publish", "manifest snapshot"],
              ["Catalog", "hosted action menu"],
            ]}
          />
        </VisualShell>
      );
    case "secret-boundary":
      return (
        <VisualShell accent={accent}>
          <div className="get-started-boundary">
            <BoundaryColumn title="source declares" rows={["SLACK_CHANNEL", "drive scope", "volume: reports"]} />
            <Shield size={22} />
            <BoundaryColumn title="platform stores" rows={["OAuth lease", "secret ref", "volume binding"]} />
          </div>
        </VisualShell>
      );
    case "dual-source":
      return (
        <VisualShell accent={accent}>
          <div className="get-started-dual-source">
            <SourceMount label="/openpond/profile" detail="agent profile source" rows={["agent/agent.ts", ".openpond/*"]} />
            <SourceMount label="/workspace" detail="target project source" rows={["src/*", "package.json"]} />
          </div>
        </VisualShell>
      );
    case "work-item":
      return (
        <VisualShell accent={accent}>
          <StatusRail
            rows={[
              ["goal", "running"],
              ["logs", "captured"],
              ["checks", "pending review"],
              ["approval", "publish blocked"],
            ]}
          />
        </VisualShell>
      );
    case "publish-snapshot":
      return (
        <VisualShell accent={accent}>
          <div className="get-started-snapshot">
            <div>
              <GitBranch size={16} />
              <span>source ref</span>
            </div>
            <div className="get-started-hash">manifest hash</div>
            <div>
              <CheckCircle2 size={16} />
              <span>published snapshot</span>
            </div>
          </div>
        </VisualShell>
      );
    case "setup-gate":
      return (
        <VisualShell accent={accent}>
          <SetupGate />
        </VisualShell>
      );
    case "surface-router":
      return (
        <VisualShell accent={accent}>
          <SurfaceRouter />
        </VisualShell>
      );
    default:
      return (
        <VisualShell accent={accent}>
          <ResourceList heading="OpenPond" rows={["profile source", "goal state", "checks", "catalog"]} />
        </VisualShell>
      );
  }
}

function VisualShell({
  accent,
  children,
}: {
  accent: GetStartedAccent;
  children: ReactNode;
}) {
  return (
    <div className={`get-started-visual accent-${accent}`}>
      <div className="get-started-visual-accent" />
      <div className="get-started-visual-inner">{children}</div>
    </div>
  );
}

function GoalCard({ detail, status, title }: { detail: string; status: string; title: string }) {
  return (
    <div className="get-started-goal-card">
      <strong>{title}</strong>
      <span>{detail}</span>
      <em>{status}</em>
    </div>
  );
}

function FlowList({ items }: { items: Array<[string, string]> }) {
  return (
    <div className="get-started-flow-list">
      {items.map(([title, detail], index) => (
        <div className="get-started-flow-row" key={title}>
          <span>{index + 1}</span>
          <div>
            <strong>{title}</strong>
            <em>{detail}</em>
          </div>
        </div>
      ))}
    </div>
  );
}

function StatusRail({ rows }: { rows: Array<[string, string]> }) {
  return (
    <div className="get-started-status-rail">
      {rows.map(([label, detail]) => (
        <div className="get-started-status-row" key={label}>
          <span />
          <strong>{label}</strong>
          <em>{detail}</em>
        </div>
      ))}
    </div>
  );
}

function ResourceList({ heading, rows }: { heading: string; rows: string[] }) {
  return (
    <div className="get-started-resource-list">
      <strong>{heading}</strong>
      {rows.map((row) => (
        <span key={row}>{row}</span>
      ))}
    </div>
  );
}

function SourceTree({ heading, rows }: { heading: string; rows: string[] }) {
  return (
    <div className="get-started-source-tree">
      <strong>{heading}</strong>
      {rows.map((row) => (
        <span key={row}>{row}</span>
      ))}
    </div>
  );
}

function DiffReview() {
  return (
    <div className="get-started-diff-review">
      <div className="get-started-diff-lines">
        <span className="added">+ agent/actions/support.ts</span>
        <span className="added">+ agent/evals/support.eval.ts</span>
        <span className="changed">~ settings/profile.yaml</span>
      </div>
      <div className="get-started-review-card">
        <strong>review</strong>
        <span>source diff</span>
        <span>check output</span>
        <span>setup rows</span>
      </div>
    </div>
  );
}

function BoundaryColumn({ rows, title }: { rows: string[]; title: string }) {
  return (
    <div className="get-started-boundary-column">
      <strong>{title}</strong>
      {rows.map((row) => (
        <span key={row}>{row}</span>
      ))}
    </div>
  );
}

function SourceMount({
  detail,
  label,
  rows,
}: {
  detail: string;
  label: string;
  rows: string[];
}) {
  return (
    <div className="get-started-source-mount">
      <strong>{label}</strong>
      <em>{detail}</em>
      {rows.map((row) => (
        <span key={row}>{row}</span>
      ))}
    </div>
  );
}

function SetupGate() {
  return (
    <div className="get-started-setup-gate">
      {[
        ["integration", "Slack lease", "missing"],
        ["secret", "REPORT_BUCKET", "ready"],
        ["volume", "reports", "optional"],
      ].map(([kind, label, status]) => (
        <div className="get-started-setup-row" key={label}>
          <span>{kind}</span>
          <strong>{label}</strong>
          <em>{status}</em>
        </div>
      ))}
    </div>
  );
}

function SurfaceRouter() {
  return (
    <div className="get-started-router">
      <div className="get-started-surface-list">
        {["web", "desktop", "Slack", "Teams", "API", "MCP"].map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
      <div className="get-started-router-core">profile router</div>
      <div className="get-started-router-output">
        <span>direct answer</span>
        <span>profile action</span>
        <span>work item</span>
      </div>
    </div>
  );
}
