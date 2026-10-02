import type {
  SandboxCreateInput,
  SandboxRecord,
  SandboxRuntime,
  SandboxRuntimeCreateInput,
} from "../../sandbox/types/index";

export type Command =
  | "import"
  | "config"
  | "home"
  | "login"
  | "profiles"
  | "account"
  | "init"
  | "profile"
  | "health"
  | "serve"
  | "app-server"
  | "ui"
  | "tui"
  | "interactive"
  | "chat"
  | "tool"
  | "deploy"
  | "backtest"
  | "apps"
  | "repo"
  | "sandbox"
  | "continual"
  | "training"
  | "taskset"
  | "human-review"
  | "connected-evidence"
  | "improve"
  | "evaluation-schedules"
  | "evaluate-refiner"
  | "experiments"
  | "datasets"
  | "desktop-test"
  | "project"
  | "agent"
  | "agents"
  | "actions"
  | "inspect"
  | "build"
  | "validate"
  | "eval"
  | "run"
  | "extension"
  | "sandbox-template"
  | "organization"
  | "organizations"
  | "template"
  | "teams-bot"
  | "opchat"
  | "opentool"
  | "check-update"
  | "version"
  | "help";

export type SandboxCreatePlan = {
  sandbox: SandboxCreateInput;
  sandboxRuntime?: SandboxRuntimeCreateInput;
  runtimeId?: string;
};

export type SandboxCreatePlanResult = {
  sandbox: SandboxRecord;
  runtime?: SandboxRuntime;
};
