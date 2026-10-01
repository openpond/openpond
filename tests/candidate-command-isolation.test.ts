import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createCandidateCommandExecutor } from "../apps/server/src/harness/experiment-candidate-command.js";

// Failure story: normal command/Agent tooling can escape a changed cwd and modify the live Profile.
it("confines real shell processes to the candidate, with fresh revision authorization and bounded output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "candidate-isolation-")), candidate = await mkdtemp(path.join(root, "candidate-")), live = path.join(root, "live-owner.txt");
  await writeFile(live, "live owner source"); let revision = 1, admissions = 0;
  const execute = createCandidateCommandExecutor({ authorize: async input => {
    admissions++; if (input.expectedRevision !== revision) throw new Error("stale candidate");
    return { candidateId: "candidate", candidateRevision: revision, ownerId: "owner", sessionId: "session", turnId: "turn", sourceRoot: candidate, writablePaths: ["."] };
  } });
  const identity = { candidateId: "candidate", sessionId: "session", turnId: "turn", expectedRevision: 1 };
  try {
    const result = await execute({ ...identity, command: `printf candidate > changed.txt; if cat '${live}'; then exit 31; fi; if printf tampered > '${live}'; then exit 32; fi; /runtime/node -e 'process.stdout.write("sdk runtime available")'` });
    expect(result.code).toBe(0); expect(result.stdout).toContain("sdk runtime available");
    expect(await readFile(path.join(candidate, "changed.txt"), "utf8")).toBe("candidate"); expect(await readFile(live, "utf8")).toBe("live owner source");
    const capped = await execute({ ...identity, command: "/runtime/node -e 'process.stdout.write(\"x\".repeat(1000))'", maxOutputBytes: 20 });
    expect(capped.stdout).toHaveLength(20); expect(capped.stdoutTruncated).toBe(true);
    revision = 2; await expect(execute({ ...identity, command: "true" })).rejects.toThrow("stale candidate");
    expect(admissions).toBe(3);
    await expect(execute({ ...identity, expectedRevision: 2, cwd: root, command: "true" })).rejects.toThrow("escapes");
  } finally { await rm(root, { recursive: true, force: true }); }
});
