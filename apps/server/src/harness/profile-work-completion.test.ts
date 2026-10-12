import { expect, test } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { contentHash, sha256 } from "@openpond/harness";
import { FileOutputRefSchema, type RuntimeEvent, type Session, type Turn } from "@openpond/contracts";
import type { TasksetRunManifest } from "@openpond/evals";
import type { LocalHarnessReleaseRecord } from "../store/store-harness-release-record.js";
import type { ModelToolExecutionContext } from "../openpond/model-tool-registry.js";
import { sanitizeRuntimeEvent } from "../runtime/runtime-event-sanitizer.js";
import { createHostProfileEvaluationTools } from "./host-profile-evaluation-tools.js";
import { profileEvaluationOutput } from "./profile-evaluation-policy-evidence.js";
import { completedProfileWorkResponse } from "./profile-work-completion.js";

// Training completion previously had no equivalent in served Profile cases:
// a large response could truncate, source paths differed, and a later command
// could mutate delivered bytes. Exercise the real namespace and receipt chain.
test("served Work seals a complete source-bound response and outputs inside its confined case", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "profile-work-finish-"));
  const revision = "source-commit", releaseHash = contentHash("release");
  const script = "print('released source available')\n";
  const scriptPath = "skills/example/scripts/example.py";
  const bundlePath = path.join(root, "bundle");
  await fs.mkdir(path.join(bundlePath, "source", path.dirname(scriptPath)), { recursive: true });
  await fs.writeFile(path.join(bundlePath, "source", scriptPath), script);
  const release = { bundlePath, agentSnapshot: { skills: [] }, harnessRelease: {
    id: "release", contentHash: releaseHash, files: [
      { path: scriptPath, contentHash: sha256(Buffer.from(script)), sizeBytes: Buffer.byteLength(script), visibility: "policy" },
      { path: "private-answer.txt", contentHash: sha256(Buffer.from("private")), sizeBytes: 7, visibility: "verifier" },
    ],
  }} as unknown as LocalHarnessReleaseRecord;
  const manifest = { id: "run", contentHash: contentHash("run"), profileEvaluation: {
    profileId: "profile", sourceRevision: revision, harnessRelease: { id: "release", contentHash: releaseHash },
  }, limits: { timeoutMs: 20_000 }, population: [{ taskId: "case", seed: "1" }] } as unknown as TasksetRunManifest;
  const session = { id: "session", currentProfile: { profileId: "profile" }, metadata: {
    profileEvaluationRun: { id: manifest.id, contentHash: manifest.contentHash },
    profileEvaluationOutputs: [{ path: "report.txt", mediaType: "text/plain", maxBytes: 100, schemaRef: null, metadata: {} }],
  }} as unknown as Session;
  const turn = { id: "turn", sessionId: session.id, status: "in_progress",
    profileSnapshot: { sourceHash: releaseHash, revision } } as Turn;
  const events: RuntimeEvent[] = [];
  const savedBytes: Buffer[] = [];
  const tools = createHostProfileEvaluationTools({ storeDir: root, release,
    getTurn: async () => turn, getSession: async () => session, authorize: async () => {},
    saveOutput: async value => {
      savedBytes.push(value.bytes);
      return { outputRef: FileOutputRefSchema.parse({ kind: "file", id: "output", revision: 1,
        title: value.suggestedName, sourceTaskId: session.id, sourceTurnId: turn.id,
        createdAt: "2026-10-12T00:00:00Z", contentType: "text/plain", sizeBytes: value.bytes.length,
        sha256: sha256(value.bytes), location: { kind: "managed", fileId: "file", downloadPath: "/outputs/file" }, validation: [],
      }) } as Awaited<ReturnType<Parameters<typeof createHostProfileEvaluationTools>[0]["saveOutput"]>>;
    }, recordOutput: async (sessionId, turnId, data) => {
      events.push({ id: "saved", name: "workspace_action_result", source: "server", sessionId, turnId,
        action: "work_output_save", status: "completed", timestamp: "2026-10-12T00:00:00Z", data });
    },
  });
  try {
    await tools.admitSession(session, manifest, "case", "1");
    const definitions = await tools.resolveTools({ session, turn } as Parameters<typeof tools.resolveTools>[0]);
    async function call(name: string, args: Record<string, unknown>) {
      const definition = definitions.find(tool => tool.name === name)!;
      return definition.execute({ session, turnId: turn.id, callId: name, args, signal: new AbortController().signal } as ModelToolExecutionContext);
    }
    const prepared = await call("work_exec", { command: "python3 '../harness/skills/example/scripts/example.py' && python3 -c 'from pathlib import Path; Path(\"response.txt\").write_text(\"complete 🐟\\n\" * 20000); Path(\"bad\").symlink_to(\"/usr/bin/python3\")'" });
    expect((prepared.data as { code: number }).code).toBe(0);
    expect((prepared.data as { stdout: string }).stdout).toContain("released source available");
    const read = await call("work_read_file", { path: "response.txt", offset: 0, maxBytes: 4000 });
    expect(read.data).toMatchObject({ truncated: true, nextOffset: 4000 });
    await expect(call("work_read_file", { path: "bad" })).rejects.toThrow("confined Work file");
    await expect(call("harness_read_file", { path: "private-answer.txt" })).rejects.toThrow("confined Work file");
    await expect(call("work_finish", { responsePath: "response.txt" })).rejects.toThrow("confined output");
    expect(savedBytes).toHaveLength(0);
    await call("work_exec", { command: "printf 'real output' > report.txt" });
    const finished = await call("work_finish", { responsePath: "response.txt" });
    expect(finished.contentText.length).toBeLessThan(250);
    expect(savedBytes.map(bytes => bytes.toString())).toEqual(["real output"]);
    events.push(sanitizeRuntimeEvent({ id: "finished", name: "tool.completed", sessionId: session.id, turnId: turn.id,
      action: "work_finish", status: "completed", timestamp: "2026-10-12T00:00:00Z", data: { result: finished.data }, output: finished.contentText }));
    events.push({id:"summary",name:"assistant.delta",sessionId:session.id,turnId:turn.id,timestamp:"2026-10-12T00:00:00Z",output:"Saved the report.",data:{providerRequestId:"response"}},
      {id:"terminal",name:"turn.completed",sessionId:session.id,turnId:turn.id,timestamp:"2026-10-12T00:00:00Z",data:{providerResponse:{requestId:"response",contentHash:contentHash("Saved the report.")}}});
    expect(profileEvaluationOutput(events,"workflow","completed")).toBe("complete 🐟\n".repeat(20000));
    await expect(call("work_exec", { command: "printf changed > report.txt" })).rejects.toThrow("sealed");
    const changed = structuredClone(events);
    (changed[0]!.data as { outputRef: { sha256: string } }).outputRef.sha256 = sha256(Buffer.from("changed"));
    expect(() => completedProfileWorkResponse(changed)).toThrow("saved-output receipt");
    expect(() => completedProfileWorkResponse([...events, events[1]!])).toThrow("multiple");
  } finally {
    tools.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 60_000);
