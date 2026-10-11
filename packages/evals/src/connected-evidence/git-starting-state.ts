import { contentHash } from "@openpond/harness";
import { ConnectedSessionSchema, resolveConnectedBoundaryMetadata } from "./contracts.js";
import { recordedCodexCommands, recordedCodexCommandResults, isRecordedReadOnlyInventory } from "./codex-command-observations.js";
import { verifyConnectedGitFileProof } from "./git-file-proof.js";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("connected_starting_state_unavailable");
  return value as Record<string, unknown>;
}

function dirtyPaths(output: string) {
  const paths: string[] = [];
  for (const line of output.split("\n")) {
    if (!line) continue;
    // Quoted/escaped paths and rename pairs need a distinct binary porcelain
    // protocol. Treat them as unavailable instead of guessing path identities.
    if (!/^[ MADRCU?!]{2} [^\x00-\x1f\x7f]+$/.test(line) || line.slice(3).includes('"')
      || line.slice(3).includes(" -> ") || line.slice(3).includes("\\"))
      throw new Error("connected_git_status_format_unsupported");
    const path = line.slice(3);
    if (path.startsWith("/") || path.split("/").some(part => part === "." || part === ".."))
      throw new Error("connected_git_status_format_unsupported");
    paths.push(path.replace(/\/$/, ""));
  }
  return paths;
}

/** Verify only the original first-tool boundary. Later requests need their own
 * captured state. Both the repository context and observations come from the
 * authorized immutable snapshot, never caller-supplied cleanliness claims. */
export function verifyConnectedGitStartingAssets(input: { session: unknown; boundaryId: string; proofs: unknown[] }) {
  const session = ConnectedSessionSchema.parse(input.session);
  const boundary = resolveConnectedBoundaryMetadata(session, input.boundaryId);
  const context = session.repositoryContext;
  if (session.origin !== "codex" || !context?.workingDirectoryHash || !context.recordedAt || boundary.projection !== "turn"
    || !session.sourceFiles.some(file => file.contentHash === context.sourceFileHash)
    || !input.proofs.length || input.proofs.length > 100) throw new Error("connected_starting_state_unavailable");
  const firstCallIndex = session.events.findIndex(event => event.kind === "tool_call");
  if (firstCallIndex <= boundary.start || firstCallIndex >= boundary.end
    || session.events.slice(0, firstCallIndex).some(event => event.kind === "compaction"))
    throw new Error("connected_starting_state_boundary_unavailable");
  const callEvent = session.events[firstCallIndex]!;
  const requestEvent = session.events[boundary.start]!;
  if (!callEvent.occurredAt || !requestEvent.occurredAt
    || Date.parse(requestEvent.occurredAt) < Date.parse(context.recordedAt)
    || Date.parse(callEvent.occurredAt) < Date.parse(requestEvent.occurredAt))
    throw new Error("connected_starting_state_observation_time_unavailable");
  const call = object(callEvent.content);
  if (call.name !== "exec" || typeof call.input !== "string" || !callEvent.callId)
    throw new Error("connected_starting_state_command_unsupported");
  const commands = recordedCodexCommands(call.input);
  const statusIndex = commands.findIndex(command => command.cmd === "git status --short");
  if (statusIndex !== commands.length - 1 || statusIndex < 1
    || commands.some(command => command.cwd !== null)
    || !commands.slice(0, statusIndex).every(command => isRecordedReadOnlyInventory(command.cmd)))
    throw new Error("connected_starting_state_command_unsupported");
  const observations = session.events.slice(firstCallIndex + 1, boundary.end);
  const resultIndex = observations.findIndex(event => event.kind === "tool_result" && event.callId === callEvent.callId);
  if (resultIndex < 0 || observations.slice(0, resultIndex).some(event => ["tool_call", "tool_result", "compaction", "message"].includes(event.kind))
    || observations.filter(event => event.kind === "tool_result" && event.callId === callEvent.callId).length !== 1)
    throw new Error("connected_starting_state_observation_unavailable");
  const resultEvent = observations[resultIndex]!;
  const results = recordedCodexCommandResults(resultEvent.content, commands.length);
  if (results.some((result, index) => result.originalTokenCount >= commands[index]!.maxOutputTokens
    || /output truncated|truncated output|\[\.\.\./i.test(result.output)))
    throw new Error("connected_starting_state_observation_truncated");
  if (contentHash(results[0]!.output.split("\n")[0]) !== context.workingDirectoryHash)
    throw new Error("connected_starting_state_directory_mismatch");
  const dirty = dirtyPaths(results[statusIndex]!.output);
  const assets = input.proofs.map(proof => verifyConnectedGitFileProof(context, proof));
  if (new Set(assets.map(asset => asset.path)).size !== assets.length)
    throw new Error("connected_starting_state_duplicate_path");
  for (const asset of assets) if (dirty.some(path => asset.path === path || asset.path.startsWith(path + "/")))
    throw new Error("connected_starting_state_selected_file_modified");
  return { schemaVersion: "openpond.connectedGitStartingAssets.v1" as const,
    sessionHash: session.contentHash, boundaryId: boundary.id, inputHash: boundary.inputHash,
    revisionHash: boundary.revisionHash, commitHash: context.commitHash,
    observationHash: contentHash({ call: callEvent, result: resultEvent }),
    selectedPathsUnmodified: true as const, dependencyClosureQualified: false as const, assets };
}
