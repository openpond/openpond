import { editable } from "openpond-agent-sdk";

export const customerReplyEditable = editable({
  enabled: true,
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
