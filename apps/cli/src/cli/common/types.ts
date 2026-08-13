import type {
  SandboxCreateInput,
  SandboxRecord,
  SandboxRuntime,
  SandboxRuntimeCreateInput,
} from "../../sandbox/types/index";

export type Command =
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
  | "training"
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
