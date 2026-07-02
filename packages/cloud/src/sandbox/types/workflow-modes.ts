export type SandboxWorkflowMode =
  | "readonly"
  | "attempt"
  | "feature"
  | "rollout"
  | "replay"
  | "template_build"
  | "scheduled_run"
  | "patch_only"
  | "hotfix"
  | "multi_feature_batch";
