export type GetStartedDeckId =
  | "goal"
  | "build"
  | "profile"
  | "local-hosted"
  | "connect-apps";

export type GetStartedAccent = "cyan";

export type GetStartedVisualKind =
  | "goal-state"
  | "goal-evidence"
  | "goal-controls"
  | "goal-context"
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
  | "surface-router";

export type GetStartedSlide = {
  id: string;
  eyebrow: string;
  title: string;
  body: string;
  detail: string;
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
    description: "How local and hosted goals keep objective, evidence, blockers, and completion visible.",
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
      {
        id: "goal-evidence-loop",
        eyebrow: "Evidence",
        title: "Every turn leaves a record",
        body: "Prompts, tool calls, file changes, checks, logs, and approvals attach to the loop as inspectable evidence.",
        detail: "The useful part is not that the model keeps talking. It is that the work leaves state the user can review.",
        visual: "goal-evidence",
        accent: cyan,
      },
      {
        id: "goal-controls-context",
        eyebrow: "Control",
        title: "Controls and context stay visible",
        body: "Pause, resume, block, complete, and clear are runtime states, while files and checks stay linked to the goal.",
        detail: "Completion should come from evidence and user-visible state, not from a loose final sentence.",
        visual: "goal-controls",
        accent: cyan,
      },
    ],
  },
  {
    id: "build",
    label: "Create & edit",
    description: "How first-class Create and Edit agents extend the goal loop for source-backed work.",
    slides: [
      {
        id: "build-one-loop",
        eyebrow: "First-class agents",
        title: "Create and Edit extend the goal loop",
        body: "Create and Edit are first-class agents specifically designed for source-backed profile work.",
        detail: "They extend the same goal loop with planning, evidence, approvals, checks, and completion before profile files change.",
        visual: "create-plan",
        accent: cyan,
      },
      {
        id: "build-profile-source",
        eyebrow: "Source",
        title: "Approved work changes profile source",
        body: "Create generates SDK-backed files. Edit patches the existing agent source. Neither becomes loose chat memory.",
        detail: "Agents, actions, prompts, evals, and non-secret setup declarations live in the profile source tree.",
        visual: "source-tree",
        accent: cyan,
      },
      {
        id: "build-checks",
        eyebrow: "Checks",
        title: "Checks decide whether it can run",
        body: "Inspect, build, validate, eval, and setup gates decide whether the changed capability is ready.",
        detail: "A missing secret or app connection should show as setup-required before the user tries the action.",
        visual: "check-stack",
        accent: cyan,
      },
      {
        id: "build-review",
        eyebrow: "Review",
        title: "Review turns agent work into a deliberate change",
        body: "Diffs, command output, checks, and setup rows stay attached until the user commits, pushes, applies, or publishes.",
        detail: "The same review habit works for local profile source and hosted work items.",
        visual: "edit-review",
        accent: cyan,
      },
    ],
  },
  {
    id: "profile",
    label: "Profile & SDK",
    description: "What the profile repo stores and what openpond-agent-sdk makes portable.",
    slides: [
      {
        id: "profile-source-home",
        eyebrow: "Profile source",
        title: "Your profile is the source home",
        body: "The profile repo stores agents, actions, prompts, evals, settings, and non-secret config.",
        detail: "Target repos stay separate. The profile is where the reusable agent capability itself lives.",
        visual: "profile-source",
        accent: cyan,
      },
      {
        id: "profile-sdk-contract",
        eyebrow: "openpond-agent-sdk",
        title: "The SDK defines the contract",
        body: "SDK source defines actions, channels, workflows, evals, editable policy, and generated artifacts.",
        detail: "The app, CLI, checks, hosted runtime, and connected apps consume those artifacts instead of guessing.",
        visual: "source-tree",
        accent: cyan,
      },
      {
        id: "profile-secrets",
        eyebrow: "Setup boundary",
        title: "Secrets and app connections stay outside Git",
        body: "Source can declare needs, but tokens, OAuth leases, and secret values live in setup and binding state.",
        detail: "This lets agents be source-backed without committing raw credentials into the profile repo.",
        visual: "secret-boundary",
        accent: cyan,
      },
    ],
  },
  {
    id: "local-hosted",
    label: "Local <> Hosted",
    description: "How local profile work becomes hosted, reviewed, and published without mixing sources.",
    slides: [
      {
        id: "local-hosted-sync",
        eyebrow: "Handoff",
        title: "Local profile changes can become hosted",
        body: "Local profile state tracks source, checks, and push status. Hosted refs track what was uploaded, checked, published, and exposed.",
        detail: "Push, check, publish, and catalog exposure are separate states so review can happen at the right boundary.",
        visual: "profile-sync",
        accent: cyan,
      },
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
        id: "local-hosted-review",
        eyebrow: "Review",
        title: "Review before it moves forward",
        body: "Review output, diffs, checks, setup rows, and source refs before accepting apply or publish steps.",
        detail: "This is the boundary where hosted work becomes a deliberate local or published source change.",
        visual: "edit-review",
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
    description: "How Slack, Teams, web, API, MCP, and other apps use the same profile catalog.",
    slides: [
      {
        id: "connect-router",
        eyebrow: "Router",
        title: "Connected apps route through the profile",
        body: "Web, desktop, Slack, Teams, API, and MCP resolve team, profile, and catalog context through one routing model.",
        detail: "The router decides direct answer, profile action, work item, setup-required response, or blocker.",
        visual: "surface-router",
        accent: cyan,
      },
      {
        id: "connect-catalog",
        eyebrow: "Catalog",
        title: "The profile catalog is the menu",
        body: "Normal chat, @agent, slash actions, and app bindings select exact catalog entries.",
        detail: "The catalog is generated from source-backed artifacts, not a hand-maintained list per app.",
        visual: "catalog",
        accent: cyan,
      },
      {
        id: "connect-context",
        eyebrow: "Permissions",
        title: "Apps provide scoped context and permissions",
        body: "Google, GitHub, Slack, Teams, Notion, Linear, and MCP tools are context sources and action channels.",
        detail: "They feed the profile/catalog system instead of becoming hardcoded agent internals.",
        visual: "secret-boundary",
        accent: cyan,
      },
      {
        id: "connect-setup",
        eyebrow: "Setup required",
        title: "Setup gates protect every app",
        body: "A missing secret, integration, volume, target repo, runtime tool, or unsupported dependency blocks early.",
        detail: "Desktop, web, Slack, Teams, API, and MCP should not each invent a different failure mode.",
        visual: "setup-gate",
        accent: cyan,
      },
    ],
  },
];
