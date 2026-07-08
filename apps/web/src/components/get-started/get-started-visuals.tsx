import type { ReactNode } from "react";
import type { GetStartedAccent, GetStartedVisualKind } from "./get-started-content";

type GetStartedVisualProps = {
  kind: GetStartedVisualKind;
  accent: GetStartedAccent;
};

type DiagramTone = "default" | "source" | "state" | "gate" | "review" | "hosted" | "warn";

export function GetStartedVisual({ accent, kind }: GetStartedVisualProps) {
  switch (kind) {
    case "goal-state":
      return (
        <VisualShell accent={accent}>
          <HubGraph
            inputs={[
              { title: "Local goal", detail: "session state", tone: "state" },
              { title: "Hosted goal", detail: "work item state", tone: "hosted" },
            ]}
            center={{ title: "Shared goal record", detail: "same lifecycle language", tone: "gate" }}
            outputs={[
              { title: "objective", detail: "what success means" },
              { title: "evidence", detail: "files, checks, logs" },
              { title: "blockers", detail: "approval or setup" },
              { title: "completion", detail: "evidence-backed" },
            ]}
          />
        </VisualShell>
      );
    case "goal-evidence":
      return (
        <VisualShell accent={accent}>
          <LoopGraph
            center="evidence state"
            nodes={[
              { title: "Prompt", detail: "objective captured" },
              { title: "Tools", detail: "files, shell, apps" },
              { title: "Events", detail: "logs and checks", tone: "gate" },
              { title: "Review", detail: "approval state" },
            ]}
          />
        </VisualShell>
      );
    case "goal-controls":
      return (
        <VisualShell accent={accent}>
          <StateGraph />
        </VisualShell>
      );
    case "goal-context":
      return (
        <VisualShell accent={accent}>
          <HubGraph
            inputs={[
              { title: "Chat turns", detail: "requests and approvals" },
              { title: "Workspace", detail: "files and source refs", tone: "source" },
            ]}
            center={{ title: "Goal context", detail: "inspectable record", tone: "gate" }}
            outputs={[
              { title: "messages", detail: "conversation trace" },
              { title: "checks", detail: "command output" },
              { title: "resources", detail: "linked files" },
              { title: "approval notes", detail: "what changed" },
            ]}
          />
        </VisualShell>
      );
    case "subagent-router":
      return (
        <VisualShell accent={accent}>
          <SubagentRouterGraph />
        </VisualShell>
      );
    case "subagent-handoff":
      return (
        <VisualShell accent={accent}>
          <SubagentHandoffGraph />
        </VisualShell>
      );
    case "subagent-settings":
      return (
        <VisualShell accent={accent}>
          <SubagentSettingsGraph />
        </VisualShell>
      );
    case "create-plan":
      return (
        <VisualShell accent={accent}>
          <FlowGraph
            nodes={[
              { title: "Ask", detail: "short request" },
              { title: "Clarify", detail: "focused questions", tone: "warn" },
              { title: "Plan", detail: "agent/action shape" },
              { title: "Review gate", detail: "confirm before source", tone: "gate" },
            ]}
          />
        </VisualShell>
      );
    case "source-tree":
      return (
        <VisualShell accent={accent}>
          <SourceContractGraph
            heading="profiles/default"
            sourceRows={["agent/agent.ts", "agent/actions/*", "agent/evals/*"]}
            artifactRows={["action-registry.json", "inspect.json", "validation.json"]}
          />
        </VisualShell>
      );
    case "check-stack":
      return (
        <VisualShell accent={accent}>
          <CheckGateGraph />
        </VisualShell>
      );
    case "catalog":
      return (
        <VisualShell accent={accent}>
          <CatalogGraph />
        </VisualShell>
      );
    case "edit-review":
      return (
        <VisualShell accent={accent}>
          <ReviewGraph />
        </VisualShell>
      );
    case "profile-source":
      return (
        <VisualShell accent={accent}>
          <SourceContractGraph
            heading="openpond-profile"
            sourceRows={["openpond-profile.json", "profiles/default/agent", "profiles/default/settings"]}
            artifactRows={["artifact-index.json", "manifest.json", "eval-results.json"]}
          />
        </VisualShell>
      );
    case "profile-sync":
      return (
        <VisualShell accent={accent}>
          <ProfileSyncGraph />
        </VisualShell>
      );
    case "secret-boundary":
      return (
        <VisualShell accent={accent}>
          <SecretBoundaryGraph />
        </VisualShell>
      );
    case "dual-source":
      return (
        <VisualShell accent={accent}>
          <DualSourceGraph />
        </VisualShell>
      );
    case "work-item":
      return (
        <VisualShell accent={accent}>
          <WorkItemGraph />
        </VisualShell>
      );
    case "publish-snapshot":
      return (
        <VisualShell accent={accent}>
          <PublishSnapshotGraph />
        </VisualShell>
      );
    case "setup-gate":
      return (
        <VisualShell accent={accent}>
          <SetupGateGraph />
        </VisualShell>
      );
    case "insights-loop":
      return (
        <VisualShell accent={accent}>
          <InsightsLoopGraph />
        </VisualShell>
      );
    case "insights-list":
      return (
        <VisualShell accent={accent}>
          <InsightsListGraph />
        </VisualShell>
      );
    case "apps-grid":
      return (
        <VisualShell accent={accent}>
          <AppsGridGraph />
        </VisualShell>
      );
    case "channel-router":
      return (
        <VisualShell accent={accent}>
          <ChannelRouterGraph />
        </VisualShell>
      );
    default:
      return (
        <VisualShell accent={accent}>
          <FlowGraph
            nodes={[
              { title: "Profile source", detail: "agent code", tone: "source" },
              { title: "Checks", detail: "inspect and eval", tone: "gate" },
              { title: "Catalog", detail: "available actions" },
            ]}
          />
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
      <div className="get-started-visual-inner">
        <div className="get-started-diagram">{children}</div>
      </div>
    </div>
  );
}

function FlowGraph({ nodes }: { nodes: DiagramNodeProps[] }) {
  return (
    <div className="get-started-flow-graph">
      {nodes.map((node, index) => (
        <FragmentWithConnector isLast={index === nodes.length - 1} key={node.title}>
          <DiagramNode {...node} />
        </FragmentWithConnector>
      ))}
    </div>
  );
}

function LoopGraph({
  center,
  nodes,
}: {
  center: string;
  nodes: DiagramNodeProps[];
}) {
  return (
    <div className="get-started-loop-graph">
      <div className="get-started-loop-ring" />
      <div className="get-started-loop-center">
        <strong>{center}</strong>
        <span>updated each turn</span>
      </div>
      {nodes.map((node) => (
        <DiagramNode {...node} key={node.title} />
      ))}
    </div>
  );
}

function StateGraph() {
  return (
    <div className="get-started-state-graph">
      <DiagramNode title="active" detail="next continuation allowed" tone="state" />
      <DiagramNode title="paused" detail="user stopped the loop" tone="warn" />
      <div className="get-started-state-core">
        <strong>runtime controls</strong>
        <span>pause, resume, clear, complete</span>
      </div>
      <DiagramNode title="blocked" detail="needs input or setup" tone="warn" />
      <DiagramNode title="complete" detail="evidence-backed finish" tone="gate" />
    </div>
  );
}

function HubGraph({
  center,
  inputs,
  outputs,
}: {
  center: DiagramNodeProps;
  inputs: DiagramNodeProps[];
  outputs: DiagramNodeProps[];
}) {
  return (
    <div className="get-started-hub-graph">
      <div className="get-started-node-stack">
        {inputs.map((node) => (
          <DiagramNode {...node} key={node.title} />
        ))}
      </div>
      <DiagramNode {...center} variant="hub" />
      <div className="get-started-node-stack compact">
        {outputs.map((node) => (
          <DiagramNode {...node} key={node.title} variant="compact" />
        ))}
      </div>
    </div>
  );
}

function SourceContractGraph({
  artifactRows,
  heading,
  sourceRows,
}: {
  artifactRows: string[];
  heading: string;
  sourceRows: string[];
}) {
  return (
    <div className="get-started-contract-graph">
      <DiagramNode title={heading} detail="profile source" tone="source">
        <MiniRows rows={sourceRows} />
      </DiagramNode>
      <Connector label="generates" />
      <DiagramNode title=".openpond artifacts" detail="machine-readable contract" tone="gate">
        <MiniRows rows={artifactRows} />
      </DiagramNode>
      <div className="get-started-consumer-strip">
        {["app", "CLI", "checks", "hosted"].map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
    </div>
  );
}

function CheckGateGraph() {
  return (
    <div className="get-started-gate-graph">
      <DiagramNode title="source change" detail="candidate profile state" tone="source" />
      <div className="get-started-check-grid">
        {[
          ["inspect", "passed"],
          ["build", "passed"],
          ["validate", "passed"],
          ["eval", "setup ready"],
        ].map(([label, status]) => (
          <div className="get-started-check-cell" key={label}>
            <strong>{label}</strong>
            <span>{status}</span>
          </div>
        ))}
      </div>
      <DiagramNode title="activate" detail="catalog can refresh" tone="gate" />
    </div>
  );
}

function CatalogGraph() {
  return (
    <HubGraph
      inputs={[
        { title: "manifest", detail: "checked snapshot", tone: "gate" },
        { title: "setup state", detail: "ready or required", tone: "warn" },
      ]}
      center={{ title: "Profile action catalog", detail: "generated menu", tone: "state" }}
      outputs={[
        { title: "default.chat", detail: "local chat" },
        { title: "support.open-items", detail: "connected app" },
        { title: "release-notes.generate", detail: "hosted action" },
      ]}
    />
  );
}

function ReviewGraph() {
  return (
    <div className="get-started-review-graph">
      <DiagramNode title="patch plan" detail="what will change" />
      <Connector label="edits" />
      <DiagramNode title="source diff" detail="+ actions, evals, settings" tone="source">
        <MiniRows rows={["+ agent/actions/support.ts", "+ agent/evals/support.eval.ts", "~ settings/profile.yaml"]} />
      </DiagramNode>
      <Connector label="checks" />
      <DiagramNode title="review gate" detail="commit, push, publish" tone="gate">
        <MiniRows rows={["source diff", "check output", "setup rows"]} />
      </DiagramNode>
    </div>
  );
}

function SubagentRouterGraph() {
  return (
    <HubGraph
      inputs={[
        { title: "Goal", detail: "objective + state", tone: "state" },
        { title: "OpenAI GPT-5.6", detail: "orchestration model", tone: "hosted" },
      ]}
      center={{ title: "Main agent", detail: "routes sub agents", tone: "gate" }}
      outputs={[
        { title: "GLM coding", detail: "copy-on-write edits" },
        { title: "Research sub agent", detail: "findings + refs" },
        { title: "Review sub agent", detail: "ranked findings" },
        { title: "Test sub agent", detail: "validation evidence" },
      ]}
    />
  );
}

function SubagentHandoffGraph() {
  return (
    <div className="get-started-subagent-handoff-graph">
      <DiagramNode title="sub agent run" detail="bounded assignment" tone="hosted" />
      <Connector label="send" />
      <DiagramNode title="sub agent message" detail="short receipt + details" tone="gate">
        <MiniRows rows={["summary", "message id", "run id"]} />
      </DiagramNode>
      <Connector label="wake" />
      <DiagramNode title="parent decides" detail="reply, route, join, cancel" tone="state" />
    </div>
  );
}

function SubagentSettingsGraph() {
  return (
    <div className="get-started-subagent-settings-graph">
      <DiagramNode title="default model" detail="shared sub agent model" tone="gate" />
      <div className="get-started-subagent-role-table">
        {[
          ["coding", "GLM", "copy-on-write"],
          ["research", "OpenAI", "read only"],
          ["review", "default", "goal scoped"],
        ].map(([role, tools, isolation]) => (
          <div className="get-started-subagent-role-row" key={role}>
            <strong>{role}</strong>
            <span>{tools}</span>
            <em>{isolation}</em>
          </div>
        ))}
      </div>
      <DiagramNode title="limits" detail="concurrency + token caps" tone="warn" />
    </div>
  );
}

function ProfileSyncGraph() {
  return (
    <div className="get-started-sync-graph">
      <DiagramNode title="local profile" detail="source + checks" tone="source" />
      <Connector label="push" />
      <DiagramNode title="hosted profile ref" detail="uploaded source" tone="hosted" />
      <Connector label="check" />
      <DiagramNode title="published catalog" detail="manifest snapshot" tone="gate" />
    </div>
  );
}

function SecretBoundaryGraph() {
  return (
    <div className="get-started-boundary-graph">
      <DiagramNode title="source declares" detail="requirements, not values" tone="source">
        <MiniRows rows={["SLACK_CHANNEL", "drive scope", "volume: reports"]} />
      </DiagramNode>
      <div className="get-started-boundary-wall">
        <strong>binding boundary</strong>
        <span>values stay outside Git</span>
      </div>
      <DiagramNode title="platform stores" detail="runtime setup state" tone="gate">
        <MiniRows rows={["OAuth lease", "secret ref", "volume binding"]} />
      </DiagramNode>
    </div>
  );
}

function DualSourceGraph() {
  return (
    <div className="get-started-dual-source-graph">
      <DiagramNode title="/openpond/profile" detail="agent profile source" tone="source">
        <MiniRows rows={["agent/agent.ts", ".openpond/*"]} />
      </DiagramNode>
      <DiagramNode title="/workspace" detail="target project source" tone="source">
        <MiniRows rows={["src/*", "package.json"]} />
      </DiagramNode>
      <div className="get-started-sandbox-core">
        <strong>hosted sandbox</strong>
        <span>runs work item with separate mounts</span>
      </div>
      <DiagramNode title="review output" detail="diffs, logs, checks, setup rows" tone="gate" />
    </div>
  );
}

function WorkItemGraph() {
  return (
    <div className="get-started-timeline-graph">
      {[
        ["goal", "running"],
        ["logs", "captured"],
        ["checks", "pending review"],
        ["approval", "publish blocked"],
      ].map(([label, detail]) => (
        <div className="get-started-timeline-step" key={label}>
          <strong>{label}</strong>
          <span>{detail}</span>
        </div>
      ))}
    </div>
  );
}

function PublishSnapshotGraph() {
  return (
    <div className="get-started-publish-graph">
      <DiagramNode title="source ref" detail="reviewed profile state" tone="source" />
      <Connector label="hash" />
      <DiagramNode title="manifest hash" detail="immutable contract" tone="gate" />
      <Connector label="publish" />
      <DiagramNode title="hosted catalog" detail="runtime action menu" tone="hosted" />
    </div>
  );
}

function SetupGateGraph() {
  return (
    <div className="get-started-setup-graph">
      <div className="get-started-setup-table">
        {[
          ["integration", "Slack lease", "missing"],
          ["secret", "REPORT_BUCKET", "ready"],
          ["volume", "reports", "optional"],
          ["target repo", "/workspace", "required"],
        ].map(([kind, label, status]) => (
          <div className="get-started-setup-row" key={label}>
            <span>{kind}</span>
            <strong>{label}</strong>
            <em>{status}</em>
          </div>
        ))}
      </div>
      <div className="get-started-gate-decision">
        <strong>setup-required</strong>
        <span>block before run or publish</span>
      </div>
    </div>
  );
}

function InsightsLoopGraph() {
  return (
    <div className="get-started-insights-loop">
      <DiagramNode title="create_pipeline.updated" detail="runtime event stream" tone="source" />
      <Connector label="scan" />
      <DiagramNode title="detector" detail="waiting, blocked, failed" tone="gate" />
      <Connector label="persist" />
      <DiagramNode title="insight_items" detail="active rows + fingerprints" tone="state" />
    </div>
  );
}

function InsightsListGraph() {
  return (
    <div className="get-started-insights-list">
      <div className="get-started-insights-toolbar">
        <span>All</span>
        <span>Active</span>
        <span>Blocker</span>
        <span>Scan</span>
      </div>
      {[
        ["Blocker", "failed", "Create agent failed"],
        ["Concern", "awaiting approval", "Edit agent needs plan approval"],
        ["Concern", "awaiting answers", "Create agent is waiting for input"],
      ].map(([severity, state, title]) => (
        <div className="get-started-insight-row" key={title}>
          <span>{severity}</span>
          <strong>{title}</strong>
          <em>{state}</em>
        </div>
      ))}
    </div>
  );
}

function AppsGridGraph() {
  return (
    <div className="get-started-apps-graph">
      <div className="get-started-app-grid">
        {CONNECTED_APP_TILES.map((app) => (
          <AppIconTile app={app} key={app.id} />
        ))}
      </div>
      <div className="get-started-router-core">
        <strong>profile catalog</strong>
        <span>actions + setup + permissions</span>
      </div>
    </div>
  );
}

function ChannelRouterGraph() {
  return (
    <div className="get-started-router-graph">
      <div className="get-started-channel-list">
        {CHANNEL_TILES.map((app) => (
          <AppIconTile app={app} key={app.id} />
        ))}
      </div>
      <div className="get-started-router-core">
        <strong>profile router</strong>
        <span>team + profile + catalog</span>
      </div>
      <div className="get-started-router-results">
        {["direct answer", "profile action", "work item", "setup-required"].map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
    </div>
  );
}

type AppIconId =
  | "github"
  | "google"
  | "slack"
  | "microsoft_teams"
  | "mcp"
  | "web";

type AppIconTileModel = {
  id: AppIconId;
  label: string;
};

const CONNECTED_APP_TILES: AppIconTileModel[] = [
  { id: "github", label: "GitHub" },
  { id: "google", label: "Google Drive" },
  { id: "slack", label: "Slack" },
  { id: "microsoft_teams", label: "Microsoft Teams" },
  { id: "mcp", label: "MCP" },
];

const CHANNEL_TILES: AppIconTileModel[] = [
  { id: "web", label: "Web" },
  { id: "slack", label: "Slack" },
  { id: "microsoft_teams", label: "Microsoft Teams" },
  { id: "mcp", label: "MCP" },
];

function AppIconTile({ app }: { app: AppIconTileModel }) {
  return (
    <span className="get-started-app-icon-tile">
      <span className="get-started-app-icon">
        <img alt="" src={iconSrcForApp(app.id)} />
      </span>
      <span>{app.label}</span>
    </span>
  );
}

function iconSrcForApp(appId: AppIconId): string {
  switch (appId) {
    case "github":
      return "/connected-apps/github.svg";
    case "google":
      return "/connected-apps/google.svg";
    case "slack":
      return "/connected-apps/slack.svg";
    case "microsoft_teams":
      return "/connected-apps/microsoft.svg";
    case "web":
      return "/openpond-icon.png";
    case "mcp":
    default:
      return "/connected-apps/openpond-mcp.svg";
  }
}

type DiagramNodeProps = {
  children?: ReactNode;
  detail: string;
  title: string;
  tone?: DiagramTone;
  variant?: "default" | "compact" | "hub";
};

function DiagramNode({
  children,
  detail,
  title,
  tone = "default",
  variant = "default",
}: DiagramNodeProps) {
  return (
    <div className={`get-started-diagram-node tone-${tone} variant-${variant}`}>
      <div className="get-started-node-heading">
        <strong>{title}</strong>
      </div>
      <span>{detail}</span>
      {children}
    </div>
  );
}

function Connector({ label }: { label?: string }) {
  return (
    <div className="get-started-connector" aria-hidden={label ? undefined : true}>
      <span />
      {label ? <em>{label}</em> : null}
    </div>
  );
}

function FragmentWithConnector({
  children,
  isLast,
}: {
  children: ReactNode;
  isLast: boolean;
}) {
  return (
    <>
      {children}
      {isLast ? null : <Connector />}
    </>
  );
}

function MiniRows({ rows }: { rows: string[] }) {
  return (
    <div className="get-started-mini-rows">
      {rows.map((row) => (
        <span key={row}>{row}</span>
      ))}
    </div>
  );
}
