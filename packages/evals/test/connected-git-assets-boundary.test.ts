import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { verifyConnectedGitFileProof } from "../src/connected-evidence/git-file-proof.js";
import { captureNativeGitAssetProofs } from "../src/native-conversations/git-assets.js";
import { previewAgentImport } from "../src/connected-evidence/imports.js";
import { verifyConnectedGitStartingAssets } from "../src/connected-evidence/git-starting-state.js";

// Failure story: a source asset is substituted from today's checkout, a sibling
// commit, or an incomplete dependency proof and becomes learner starting state.
// Real Git writes these objects; the verifier never reads the fixture checkout.
test("binds historical file bytes through the complete recorded Git object path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "connected-git-proof-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, stdio: ["ignore", "pipe", "pipe"] });
  try {
    git("init", "--quiet");
    await mkdir(join(directory, "src"));
    await writeFile(join(directory, "src/feature.ts"), "export const value = 'original';\n");
    git("add", "src/feature.ts");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "Original state");
    const commitHash = git("rev-parse", "HEAD").toString().trim();
    const context = { schemaVersion: "openpond.connectedRepositoryContext.v1", kind: "git", commitHash,
      branch: null, recordedAt: "2026-10-01T00:00:00Z", sourceFileHash: "a".repeat(64), metadataHash: "b".repeat(64) };
    const proof = { schemaVersion: "openpond.connectedGitFileProof.v1", path: "src/feature.ts",
      commit: { hash: commitHash, base64: git("cat-file", "commit", commitHash).toString("base64") },
      trees: ["HEAD^{tree}", "HEAD:src"].map(ref => {
        const hash = git("rev-parse", ref).toString().trim();
        return { hash, base64: git("cat-file", "tree", hash).toString("base64") };
      }), contentsBase64: git("show", "HEAD:src/feature.ts").toString("base64") };
    const recordedStatus = git("status", "--short").toString();
    const commands = 'text(await tools.exec_command({cmd:"pwd",max_output_tokens:3000}));\n'
      + 'text(await tools.exec_command({cmd:"git status --short",max_output_tokens:3000}));';
    const source = (status = recordedStatus, input = commands, budgetTokens = 10) => {
      const rows = [
        { type: "session_meta", payload: { id: "source", timestamp: "2026-10-01T00:00:00Z", cwd: directory,
          git: { commit_hash: commitHash } } },
        { type: "response_item", timestamp: "2026-10-01T00:00:01Z", payload: { type: "message", role: "user", content: "Change the feature." } },
        { type: "response_item", timestamp: "2026-10-01T00:00:01Z", payload: { type: "custom_tool_call", call_id: "status", name: "exec", input } },
        { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "status", output: [
          { type: "input_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
          ...[directory + "\n", status].map(output => ({ type: "input_text", text: JSON.stringify({ exit_code: 0, output, original_token_count: budgetTokens }) })),
        ] } },
        { type: "response_item", payload: { type: "message", role: "assistant", content: "Finished." } },
        { type: "event_msg", payload: { type: "task_complete" } },
        { type: "response_item", timestamp: "2026-10-01T00:00:02Z", payload: { type: "message", role: "user", content: "Now change it again." } },
      ];
      const preview = previewAgentImport({ source: "codex", files: [{ path: "rollout.jsonl", text: rows.map(row => JSON.stringify(row)).join("\n") }] });
      expect(preview.issues).toEqual([]);
      return preview.sessions[0]!;
    };
    const session = source();
    const admit = (value = session, boundaryId = value.boundaries[0]!.id) => verifyConnectedGitStartingAssets({ session: value, boundaryId, proofs: [proof] });
    await writeFile(join(directory, "src/feature.ts"), "export const value = 'later answer';\n");
    expect(admit().selectedPathsUnmodified).toBe(true);
    expect(admit().assets[0]!.sha256).toEqual(verifyConnectedGitFileProof(context, proof).sha256);
    expect(() => admit(source(git("status", "--short").toString()))).toThrow("selected_file_modified");
    expect(() => admit(source("?? src/\n"))).toThrow("selected_file_modified");
    expect(() => admit(source(' M "src/feature.ts"\n'))).toThrow("format_unsupported");
    expect(() => admit(source("", commands, 3000))).toThrow("observation_truncated");
    expect(() => admit(source("", commands.replace('cmd:"pwd"', 'cmd:"touch src/feature.ts"')))).toThrow("command_unsupported");
    expect(() => admit(session, session.boundaries[1]!.id)).toThrow("boundary_unavailable");
    const verified = verifyConnectedGitFileProof(context, proof);
    expect(Buffer.from(verified.contentsBase64, "base64").toString()).toContain("original");
    const captured = await captureNativeGitAssetProofs({ repositoryPath: directory, repositoryContext: context, paths: [proof.path] });
    expect(captured[0]!.verified).toEqual(verified);
    await expect(captureNativeGitAssetProofs({ repositoryPath: directory,
      repositoryContext: { ...context, commitHash: "c".repeat(40) }, paths: [proof.path] })).rejects.toThrow();
    expect(() => verifyConnectedGitFileProof(context, { ...proof,
      contentsBase64: Buffer.from("export const value = 'later answer';\n").toString("base64") })).toThrow("blob_mismatch");
    expect(() => verifyConnectedGitFileProof({ ...context, commitHash: "c".repeat(40) }, proof)).toThrow("commit_mismatch");
    expect(() => verifyConnectedGitFileProof(context, { ...proof, path: "src/missing.ts" })).toThrow("path_missing");
    expect(() => verifyConnectedGitFileProof(context, { ...proof, trees: proof.trees.slice(0, 1) })).toThrow("tree_missing");
    expect(() => verifyConnectedGitFileProof(context, { ...proof, contentsBase64: proof.contentsBase64 + "\n" })).toThrow("bytes_invalid");
    expect(() => verifyConnectedGitFileProof(context, { ...proof, path: "../feature.ts" })).toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
