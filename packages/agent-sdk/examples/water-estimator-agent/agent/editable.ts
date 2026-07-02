import { editable } from "openpond-agent-sdk";

export const waterEstimatorEditable = editable({
  enabled: true,
  backend: "openpond-coding-work-item",
  runtimeEnvironmentId: "openpond-coding-core-v1",
  sourceOfTruth: "agent-source",
  policyDiscovery: {
    command: "openpond agent inspect --json",
    runAfter: "source-materialized",
  },
  allowedPaths: [
    "agent/**",
    "src/**",
    "package.json",
    "README.md",
  ],
  requiredChecks: [
    "openpond-agent validate",
    "openpond-agent eval",
  ],
  defaultResultMode: "patch_only",
  supportedResultModes: [
    "patch_only",
    "commit_to_runtime_ref",
    "create_branch",
    "open_pr",
  ],
});
