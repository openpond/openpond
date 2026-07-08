export type GetStartedDeckId =
  | "goal"
  | "orchestration"
  | "build"
  | "insights"
  | "profile"
  | "local-hosted"
  | "connect-apps";

export type GetStartedAccent = "cyan";

export type GetStartedVisualKind =
  | "goal-state"
  | "goal-evidence"
  | "goal-controls"
  | "goal-context"
  | "subagent-router"
  | "subagent-handoff"
  | "subagent-settings"
  | "create-plan"
  | "source-tree"
  | "check-stack"
  | "catalog"
  | "edit-review"
  | "profile-source"
  | "profile-sync"
  | "secret-boundary"
  | "dual-source"
  | "work-item"
  | "publish-snapshot"
  | "setup-gate"
  | "insights-loop"
  | "insights-list"
  | "apps-grid"
  | "channel-router";

export type GetStartedSlide = {
  id: string;
  eyebrow: string;
  title: string;
  body?: string;
  detail?: string;
  visual: GetStartedVisualKind;
  accent: GetStartedAccent;
};

export type GetStartedDeck = {
  id: GetStartedDeckId;
  label: string;
  description: string;
  slides: GetStartedSlide[];
};

const cyan = "cyan" satisfies GetStartedAccent;

export const GET_STARTED_DECKS: GetStartedDeck[] = [
  {
    id: "goal",
    label: "Goal loop",
    description: "How local and hosted goals share durable objective state.",
    slides: [
      {
        id: "goal-durable-objective",
        eyebrow: "Goal state",
        title: "Goals are durable objectives",
        body: "A goal is saved state for a local session or hosted work item, not just prompt text.",
        detail: "Local and hosted goals use the same lifecycle language: objective, evidence, blockers, approvals, checks, and completion.",
        visual: "goal-state",
        accent: cyan,
      },
    ],
  },
  {
    id: "orchestration",
    label: "Orchestration",
    description: "How the main agent delegates bounded work to addressable sub agents.",
    slides: [
      {
        id: "orchestration-delegate",
        eyebrow: "Model routing",
        title: "OpenAI GPT-5.6 can coordinate GLM coding",
        body: "Use a strong orchestration model to split a goal into sub agents, then route coding, research, review, testing, docs, or planning to the role and model that fit.",
        detail: "For example: OpenAI GPT-5.6 coordinates the goal, GLM handles coding in copy-on-write isolation, and every sub agent reports receipts back to the main chat.",
        visual: "subagent-router",
        accent: cyan,
      },
      {
        id: "orchestration-handoff",
        eyebrow: "Handoffs",
        title: "Sub agents report back deliberately",
        body: "Sub agents can send compact handoffs back to the parent chat when a blocker, decision, important finding, or final result should return control.",
        detail: "The parent sees a short sub agent receipt and can respond, message the sub agent, join or cancel, update the goal, or route follow-up work.",
        visual: "subagent-handoff",
        accent: cyan,
      },
      {
        id: "orchestration-settings",
        eyebrow: "Harness settings",
        title: "Configure each sub agent role",
        body: "Sub agents have a default model plus per-role provider and model overrides, tool policies, isolation modes, concurrency caps, token caps, and peer-message rules.",
        detail: "Copy-on-write is the default for write-capable sub agents so parallel edits stay reviewable before merge or handoff; roles can also use worktrees or no isolation.",
        visual: "subagent-settings",
        accent: cyan,
      },
    ],
  },
  {
    id: "build",
    label: "Create/Edit Loop",
    description: "How first-class Create and Edit agents are specific implementations on top of goals.",
    slides: [
      {
        id: "build-one-loop",
        eyebrow: "First-class agents",
        title: "Create/Edit is built on goals",
        body: "Create and Edit are first-class agents specifically designed as implementations on top of the goal loop.",
        detail: "They add source-aware planning, evidence, approvals, checks, and completion before profile files change.",
        visual: "create-plan",
        accent: cyan,
      },
      {
        id: "build-profile-source",
        eyebrow: "Source",
        title: "Approved work changes profile source",
        body: "Create generates SDK-backed files. Edit patches existing agent source. Neither becomes loose chat memory.",
        detail: "Agents, actions, prompts, evals, and non-secret setup declarations live in the profile source tree.",
        visual: "source-tree",
        accent: cyan,
      },
    ],
  },
  {
    id: "insights",
    label: "Insights Loop",
    description: "How Insights is a specific implementation on top of goals and create/edit pipeline state.",
    slides: [
      {
        id: "insights-detect",
        eyebrow: "Detector",
        title: "Insights runs on top of goals",
        body: "Insights is a specific implementation on top of goals: it watches `create_pipeline.updated` events and turns stuck create/edit states into active rows.",
        detail: "Awaiting questions, plan approval, blocked, and failed states become concern or blocker rows tied back to the source event.",
        visual: "insights-loop",
        accent: cyan,
      },
      {
        id: "insights-action",
        eyebrow: "Action",
        title: "Insights stay actionable",
        body: "Background scans run on startup and interval, `/insights` can force a scan, and the UI lets users filter, resolve, or dismiss rows.",
        detail: "Rows persist in `insight_items` and resolve when the pipeline moves forward or the user marks them handled.",
        visual: "insights-list",
        accent: cyan,
      },
    ],
  },
  {
    id: "profile",
    label: "Profile",
    description: "How one Git-backed profile repository makes agents portable.",
    slides: [
      {
        id: "profile-git-repo",
        eyebrow: "Git-backed source",
        title: "One agent repository travels with you",
        body: "The profile repo stores agents, actions, prompts, evals, settings, and non-secret config as source.",
        detail: "Because it is Git-backed, local app, CLI, checks, and hosted runtime can inspect the same durable agent repository.",
        visual: "profile-source",
        accent: cyan,
      },
      {
        id: "profile-portable-artifacts",
        eyebrow: "Portability",
        title: "Artifacts make agents portable",
        body: "The SDK emits a manifest, action registry, inspect output, validation report, and eval results from that repo.",
        detail: "Those contracts let the same agent run locally, publish hosted, or appear in connected apps without rebuilding it by hand.",
        visual: "source-tree",
        accent: cyan,
      },
    ],
  },
  {
    id: "local-hosted",
    label: "Local <> Hosted",
    description: "How hosted work keeps sources separate and publishes reviewed snapshots.",
    slides: [
      {
        id: "local-hosted-mounts",
        eyebrow: "Sandbox",
        title: "Hosted work keeps sources separate",
        body: "A hosted work item can mount profile source for the agent and target source for the project being changed.",
        detail: "The profile mount is `/openpond/profile`. The target project mount is `/workspace` when a target repo is needed.",
        visual: "dual-source",
        accent: cyan,
      },
      {
        id: "local-hosted-publish",
        eyebrow: "Publish",
        title: "Published snapshots avoid source drift",
        body: "A checked manifest snapshot becomes the runtime source for hosted profile actions.",
        detail: "The hosted catalog should point at a reviewed snapshot, not an ambiguous latest file tree.",
        visual: "publish-snapshot",
        accent: cyan,
      },
    ],
  },
  {
    id: "connect-apps",
    label: "Connect 3rd party apps",
    description: "How connected apps bind into the same profile catalog.",
    slides: [
      {
        id: "connect-apps-grid",
        eyebrow: "Apps",
        title: "Apps connect to the profile catalog",
        visual: "apps-grid",
        accent: cyan,
      },
      {
        id: "connect-channels",
        eyebrow: "Channels",
        title: "Web, Slack, Teams, and MCP use the same router",
        visual: "channel-router",
        accent: cyan,
      },
    ],
  },
];
