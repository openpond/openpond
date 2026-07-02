import { editable } from "openpond-agent-sdk";

export const customerReplyEditable = editable({
  enabled: true,
  backend: "openpond-coding-work-item",
  runtimeEnvironmentId: "openpond-coding-core-v1",
  sourceOfTruth: "agent-source",
  policyDiscovery: {
    command: "openpond agent inspect --json",
    runAfter: "source-materialized",
  },
  allowedPaths: ["agent/**", "package.json", "README.md"],
  requiredChecks: ["openpond-agent validate", "openpond-agent eval"],
  defaultResultMode: "patch_only",
  supportedResultModes: ["patch_only", "create_branch", "open_pr"],
});
