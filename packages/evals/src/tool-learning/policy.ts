import { ToolEpisodeEventSchema } from "./episodes.js";
import { ToolLearningCapturePolicySchema } from "./installations.js";
import { toolLearningContentHash } from "./primitives.js";

/** Shared local-persistence/intake boundary. A hash alone does not grant consent. */
export function assertToolEpisodeCapturePolicy(eventValue: unknown, policyValue: unknown): void {
  const event = ToolEpisodeEventSchema.parse(eventValue);
  const policy = ToolLearningCapturePolicySchema.parse(policyValue);
  if (!policy.purposes.includes("capture")) throw new Error("tool_learning_capture_not_enabled");
  if (
    event.sanitization.policyRevision !== policy.revision ||
    event.sanitization.policyHash !== toolLearningContentHash(policy)
  )
    throw new Error("tool_learning_capture_policy_changed");
  if (new TextEncoder().encode(JSON.stringify(event)).byteLength > policy.maximumEventBytes)
    throw new Error("tool_learning_event_policy_limit");
  const permits = (field: (typeof policy.permittedFields)[number]) =>
    policy.permittedFields.includes(field);
  if (event.eventKind === "attempt") {
    if (!policy.permittedTools.includes(event.payload.tool.name))
      throw new Error("tool_learning_tool_outside_collection_policy");
    if (
      !permits("action") ||
      (!permits("intent") && event.payload.intent !== "") ||
      (!permits("state") && Object.keys(event.payload.environment.state).length > 0) ||
      (!permits("artifact_reference") && event.payload.contextAssets.length > 0)
    )
      throw new Error("tool_learning_attempt_field_outside_collection_policy");
  }
  if (event.eventKind === "observation") {
    if (
      (!permits("result_excerpt") &&
        (event.payload.resultExcerpt !== "" ||
          (event.payload.outcome === "failed" && event.payload.message !== ""))) ||
      (!permits("artifact_reference") && event.payload.assets.length > 0)
    )
      throw new Error("tool_learning_result_field_outside_collection_policy");
  }
  if (
    event.eventKind === "verification" &&
    ((!permits("result_excerpt") && event.payload.reason !== "") ||
      (!permits("artifact_reference") && event.payload.outputArtifacts.length > 0))
  )
    throw new Error("tool_learning_verification_field_outside_collection_policy");
  if (event.eventKind === "lineage" && !permits("intent") && event.payload.reason !== "")
    throw new Error("tool_learning_lineage_field_outside_collection_policy");
}
