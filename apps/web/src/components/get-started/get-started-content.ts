export type GetStartedDeckId =
  | "goal"
  | "create"
  | "edit"
  | "profile"
  | "dual-source"
  | "surfaces";

export type GetStartedAccent = "cyan" | "emerald" | "violet" | "amber" | "sky" | "stone";

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

export const GET_STARTED_DECKS: GetStartedDeck[] = [
  {
    id: "goal",
    label: "Goal loop",
    description: "How local and hosted goals keep objective, evidence, and completion state visible.",
    slides: [
      {
        id: "goal-durable-objective",
        eyebrow: "Goal state",
        title: "Goals are durable objectives",
        body: "A goal is saved state for a local session or hosted work item, not just prompt text.",
        detail: "Local and hosted goals use the same product language: objective, evidence, approvals, blockers, checks, and completion.",
        visual: "goal-state",
        accent: "cyan",
      },
      {
        id: "goal-evidence-loop",
        eyebrow: "Evidence",
        title: "The loop keeps working with evidence",
        body: "Each turn can add progress, events, checks, source refs, approvals, and blockers.",
        detail: "The useful part is not that the model keeps talking. It is that the work leaves inspectable state.",
        visual: "goal-evidence",
        accent: "emerald",
      },
      {
        id: "goal-controls",
        eyebrow: "Control",
        title: "You can pause, resume, or clear",
        body: "The runtime owns lifecycle controls while the model reports what it completed and what still blocks progress.",
        detail: "Completion should come from evidence, not from a loose final sentence.",
        visual: "goal-controls",
        accent: "sky",
      },
      {
        id: "goal-context",
        eyebrow: "Context",
        title: "Goal context stays inspectable",
        body: "Goal state and related resources stay readable from the UI instead of hiding inside chat prose.",
        detail: "Files, checks, messages, approvals, and work-item state become part of the same review surface.",
        visual: "goal-context",
        accent: "stone",
      },
    ],
  },
  {
    id: "create",
    label: "Create loop",
    description: "How a short ask becomes reviewed profile source and a local action catalog entry.",
    slides: [
      {
        id: "create-short-ask",
        eyebrow: "Create",
        title: "Create starts from a short ask",
        body: "Describe the repeatable capability you want. The planner can ask focused questions before source changes.",
        detail: "A short user prompt stays short. The system carries SDK, setup, source, and check requirements internally.",
        visual: "create-plan",
        accent: "emerald",
      },
      {
        id: "create-plan-review",
        eyebrow: "Review",
        title: "Plan review comes before source",
        body: "The plan shows the agent name, action shape, setup needs, data assumptions, and check plan.",
        detail: "Confirm, revise, or cancel before Create mutates profile source.",
        visual: "create-plan",
        accent: "cyan",
      },
      {
        id: "create-source",
        eyebrow: "Source",
        title: "Source is generated into the profile",
        body: "Approved Create writes SDK-backed profile source, not loose chat memory.",
        detail: "Profile source is the durable place for agents, actions, prompts, evals, and non-secret setup declarations.",
        visual: "source-tree",
        accent: "violet",
      },
      {
        id: "create-checks",
        eyebrow: "Checks",
        title: "Checks gate activation",
        body: "Inspect, build, validate, eval, and setup gate status decide whether the generated agent can run.",
        detail: "A missing secret or app lease should show as setup-required before the user tries the action.",
        visual: "check-stack",
        accent: "amber",
      },
      {
        id: "create-ready-local",
        eyebrow: "Ready local",
        title: "Ready local means try it in chat",
        body: "The local catalog refreshes and the generated action can be invoked from normal chat.",
        detail: "That same source can later be pushed and published into the hosted catalog.",
        visual: "catalog",
        accent: "sky",
      },
    ],
  },
  {
    id: "edit",
    label: "Edit loop",
    description: "How existing profile agents change through source diffs, checks, and review.",
    slides: [
      {
        id: "edit-target",
        eyebrow: "Target",
        title: "Edit targets an existing capability",
        body: "Edit resolves the active profile, selected agent or action, and source ref before changing anything.",
        detail: "The loop should know what it is changing and why before it starts touching files.",
        visual: "catalog",
        accent: "violet",
      },
      {
        id: "edit-plan",
        eyebrow: "Patch plan",
        title: "The requested change becomes a patch plan",
        body: "The user should see what the agent intends to alter before the source edit proceeds.",
        detail: "That keeps edits tied to a source-backed capability instead of becoming a new one-off answer.",
        visual: "create-plan",
        accent: "cyan",
      },
      {
        id: "edit-source-checks",
        eyebrow: "Source edit",
        title: "The agent edits source and runs checks",
        body: "Source changes, command output, diffs, and check status stay attached to the loop.",
        detail: "The check stack is part of the product surface, not just hidden terminal output.",
        visual: "edit-review",
        accent: "emerald",
      },
      {
        id: "edit-review",
        eyebrow: "Review",
        title: "Review is part of the workflow",
        body: "Inspect source changes and evidence before committing, pushing, or publishing.",
        detail: "The review step is where agent work turns into a deliberate source change.",
        visual: "edit-review",
        accent: "amber",
      },
      {
        id: "edit-publish",
        eyebrow: "Publish",
        title: "Publish only after gates pass",
        body: "Hosted publish should use checked source and setup-ready metadata.",
        detail: "The hosted catalog should point at the reviewed source state, not an ambiguous latest file tree.",
        visual: "publish-snapshot",
        accent: "sky",
      },
    ],
  },
  {
    id: "profile",
    label: "Profile & SDK",
    description: "What the profile repo and openpond-agent-sdk each own.",
    slides: [
      {
        id: "profile-source-home",
        eyebrow: "Profile source",
        title: "Your profile is the source home",
        body: "The profile repo stores agents, actions, prompts, evals, settings, and non-secret config.",
        detail: "Target repos stay separate. The profile is where the agent capability itself lives.",
        visual: "profile-source",
        accent: "cyan",
      },
      {
        id: "profile-sdk-contract",
        eyebrow: "openpond-agent-sdk",
        title: "The SDK defines the contract",
        body: "SDK source defines actions, channels, workflows, evals, editable policy, and generated artifacts.",
        detail: "The app, CLI, checks, hosted runtime, and connected surfaces consume those artifacts instead of guessing.",
        visual: "source-tree",
        accent: "emerald",
      },
      {
        id: "profile-artifacts",
        eyebrow: "Artifacts",
        title: "Artifacts make agents portable",
        body: "The manifest, action registry, inspect output, validation report, and eval results are machine-readable contracts.",
        detail: "The artifact index tells the platform what was generated and whether it matches the expected schema.",
        visual: "profile-source",
        accent: "violet",
      },
      {
        id: "profile-sync",
        eyebrow: "Local to hosted",
        title: "Local profile changes can become hosted",
        body: "Local profile state tracks source, checks, and push status. Hosted refs track what was uploaded, checked, published, and exposed.",
        detail: "Push, check, publish, and catalog exposure are separate states so review can happen at the right boundary.",
        visual: "profile-sync",
        accent: "sky",
      },
      {
        id: "profile-secrets",
        eyebrow: "Setup boundary",
        title: "Secrets and app connections stay outside Git",
        body: "Source can declare needs, but tokens, OAuth leases, and secret values live in setup and binding state.",
        detail: "This lets agents be source-backed without committing raw credentials into the profile repo.",
        visual: "secret-boundary",
        accent: "amber",
      },
    ],
  },
  {
    id: "dual-source",
    label: "Dual-source sandbox",
    description: "How hosted work separates profile source from target project source.",
    slides: [
      {
        id: "dual-source-mounts",
        eyebrow: "Hosted work",
        title: "Hosted work can mount two sources",
        body: "A hosted create/edit work item can materialize profile source for the agent and target source for the project being changed.",
        detail: "The profile mount is `/openpond/profile`. The target project mount is `/workspace` when a target repo is needed.",
        visual: "dual-source",
        accent: "cyan",
      },
      {
        id: "dual-source-evidence",
        eyebrow: "Work item",
        title: "Sandbox runs preserve evidence",
        body: "Work items carry goal state, logs, checks, source refs, setup gates, and publish approvals.",
        detail: "Hosted work should remain inspectable after the sandbox process exits.",
        visual: "work-item",
        accent: "emerald",
      },
      {
        id: "dual-source-review",
        eyebrow: "Review",
        title: "Review what changed before applying it",
        body: "Review output, diffs, checks, and setup rows before accepting source or publish steps.",
        detail: "Use review, apply, push, and publish language rather than loose clipboard language.",
        visual: "edit-review",
        accent: "amber",
      },
      {
        id: "dual-source-publish",
        eyebrow: "Published snapshot",
        title: "Publish reconciles the hosted catalog",
        body: "A checked manifest snapshot becomes the runtime source for hosted profile actions.",
        detail: "The action menu can point at a reviewed published snapshot instead of unreviewed source drift.",
        visual: "publish-snapshot",
        accent: "sky",
      },
      {
        id: "dual-source-setup",
        eyebrow: "Setup gate",
        title: "Setup required stops bad runs early",
        body: "Missing integrations, secrets, volumes, target repos, runtime tools, or unsupported dependencies block early.",
        detail: "The same requirement row should explain the blocker before local run, hosted publish, or connected-app execution.",
        visual: "setup-gate",
        accent: "violet",
      },
    ],
  },
  {
    id: "surfaces",
    label: "Surfaces",
    description: "How web, desktop, Slack, Teams, API, and MCP route through one profile catalog.",
    slides: [
      {
        id: "surfaces-router",
        eyebrow: "Router",
        title: "One router, many surfaces",
        body: "Web, desktop, TUI, Slack, Teams, API, and MCP resolve profile context through the same routing model.",
        detail: "The router decides direct answer, profile action, work item, setup-required response, or blocker.",
        visual: "surface-router",
        accent: "sky",
      },
      {
        id: "surfaces-catalog",
        eyebrow: "Catalog",
        title: "The profile action catalog is the menu",
        body: "Normal chat, @agent, slash actions, and connected apps select exact catalog entries.",
        detail: "The catalog is generated from source-backed artifacts, not a hand-maintained list per surface.",
        visual: "catalog",
        accent: "cyan",
      },
      {
        id: "surfaces-bindings",
        eyebrow: "Bindings",
        title: "Slack and Teams bind to a profile",
        body: "Connected app bindings should target a team and profile first, with optional default agent or action routing.",
        detail: "That avoids creating separate bot definitions for the same capability.",
        visual: "surface-router",
        accent: "emerald",
      },
      {
        id: "surfaces-app-context",
        eyebrow: "Connected apps",
        title: "Apps provide context and permissions",
        body: "Google, GitHub, Slack, Teams, Notion, Linear, and MCP tools are scoped context sources and action surfaces.",
        detail: "They should feed the profile/catalog system instead of becoming hardcoded agent internals.",
        visual: "secret-boundary",
        accent: "amber",
      },
      {
        id: "surfaces-setup",
        eyebrow: "Setup required",
        title: "Setup gates protect every surface",
        body: "A missing secret or integration should produce the same setup-required explanation in every surface.",
        detail: "Desktop, web, Slack, Teams, API, and MCP should not each invent a different failure mode.",
        visual: "setup-gate",
        accent: "violet",
      },
    ],
  },
];
