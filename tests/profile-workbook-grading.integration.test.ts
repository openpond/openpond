import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { contentHash } from "@openpond/harness";
import type { RuntimeEvent, Session } from "@openpond/contracts";
import { executeJavaScriptVerifierInWorker } from "@openpond/evals/javascript-verifier/node";
import { createWorkOutputService } from "../apps/server/src/work/work-output-service";
import { readLocalProfileArtifacts } from "../apps/server/dist/evaluations/local-profile-artifacts.js";
import { inspectWorkbook } from "../apps/server/dist/evaluations/workbook-inspector.js";
const { Workbook } = createRequire(
  new URL("../apps/server/package.json", import.meta.url),
)("exceljs");

// Failure story: a correct text response or copied artifact name used to pass
// despite an incorrect XLSX. Exercise the real saved-file owner, parser, formula
// engine and private JS isolate; replacements/revocation must supply no grade.
test("grades retained workbook bytes and rejects incorrect calculations, replacement and revoked access", async () => {
  const storeDir = await mkdtemp(path.join(os.tmpdir(), "workbook-grading-"));
  const events: RuntimeEvent[] = [];
  const session = { id: "case-session", experience: "work" } as Session;
  const owner = createWorkOutputService({
    deviceId: "qualified-device",
    storeDir,
    runtimeEventsForSession: async () => events,
  });
  let allowed = true;
  const authorize = async () => {
    if (!allowed) throw new Error("Artifact access revoked.");
  };
  async function retain(formula: string, cachedValue: number) {
    const book = new Workbook();
    book.addWorksheet("Variables").getCell("B1").value = 3;
    book.addWorksheet("Draft Estimate").getCell("B1").value = {
      formula,
      result: cachedValue,
    };
    const saved = await owner.saveOwnedOutputBytes({
      session,
      sourceTurnId: "case-turn",
      suggestedName: "rfq-installation.xlsx",
      bytes: Buffer.from(await book.xlsx.writeBuffer()),
      validation: [],
      validationPolicy: "preserve",
    });
    events.push({
      id: `save-${events.length}`,
      sessionId: session.id,
      turnId: "case-turn",
      name: "workspace_action_result",
      timestamp: new Date().toISOString(),
      source: "server",
      action: "work_output_save",
      status: "completed",
      data: saved,
    });
    const ref = saved.outputRef;
    const attempt = {
      profileNative: {
        sessionId: session.id,
        turnId: "case-turn",
        traceHash: contentHash(events),
      },
      artifactRefs: [
        {
          id: `${session.id}/${ref.id}/${ref.revision}/${ref.title}`,
          contentHash: ref.sha256,
          mediaType: ref.contentType,
          sizeBytes: ref.sizeBytes,
        },
      ],
    };
    return {
      saved,
      read: () =>
        readLocalProfileArtifacts({
          storeDir,
          attempt,
          events: async () => events,
          authorize,
          probeSheets: ["Variables"],
        }),
    };
  }
  const source = `export function verify({artifacts}) {
    const book=artifacts[0]?.workbook, cell=book?.sheets.find(s=>s.name==='Draft Estimate')?.cells.find(c=>c.address==='B1');
    const passed=book?.status==='inspected'&&cell?.value===900&&book.probes.some(p=>p.changed.some(c=>c.sheet==='Draft Estimate'&&c.after===1200));
    return {passed,score:passed?1:0,feedback:passed?'Verified retained cells':'Workbook calculation differs'};
  }`;
  const grade = async (artifacts: unknown) =>
    executeJavaScriptVerifierInWorker({
      source,
      value: {
        artifacts,
        output: {
          text: "The correct total is 900",
          artifacts: [{ workbook: { status: "inspected" } }],
        },
      },
      timeoutMs: 1000,
    });
  try {
    const correct = await retain("Variables!B1*300", 900),
      artifacts = await correct.read();
    expect(await grade(artifacts)).toMatchObject({ passed: true, score: 1 });
    expect(artifacts[0]).not.toHaveProperty("base64");
    const inspected = artifacts[0]! as {
      inspectionRef: { id: string; contentHash: string };
    };
    const snapshot = JSON.parse(
      await readFile(
        path.join(
          storeDir,
          "evaluation-artifact-inspections",
          `${inspected.inspectionRef.contentHash}.json`,
        ),
        "utf8",
      ),
    );
    expect(contentHash(snapshot)).toBe(inspected.inspectionRef.contentHash);
    const concurrent = await Promise.all([correct.read(), correct.read()]);
    expect(concurrent.map((value) => value[0]?.inspectionRef?.id)).toEqual([
      inspected.inspectionRef.id,
      inspected.inspectionRef.id,
    ]);
    expect(artifacts[0]).toMatchObject({
      reference: { contentHash: correct.saved.outputRef.sha256 },
    });
    const wrong = await retain("Variables!B1*200", 900);
    expect(await grade(await wrong.read())).toMatchObject({
      passed: false,
      score: 0,
    });
    const broken = await retain("1/0", 900);
    expect((await broken.read())[0]).toMatchObject({
      workbook: { status: "invalid" },
    });
    allowed = false;
    await expect(broken.read()).rejects.toThrow(/revoked/);
    allowed = true;
    const replaced = await retain("Variables!B1*300", 900);
    if (replaced.saved.outputRef.location.kind !== "local")
      throw new Error("Expected canonical local output.");
    await writeFile(replaced.saved.outputRef.location.path, "replacement");
    await expect(replaced.read()).rejects.toThrow(
      /bytes changed|sealed receipt/,
    );
    const corrupt = await inspectWorkbook({
      bytes: Buffer.from("PK invalid workbook"),
    });
    expect(corrupt.status).toBe("invalid");
    const bomb = new Workbook();
    bomb.addWorksheet("Too large").getCell("A1").value = "a".repeat(8_000_001);
    const expanded = await inspectWorkbook({
      bytes: Buffer.from(await bomb.xlsx.writeBuffer()),
    });
    expect(expanded).toMatchObject({ status: "invalid" });
    expect(expanded.errors.join(" ")).toMatch(/expansion limit/);
    const volatile = await retain("RAND()", 1);
    expect((await volatile.read())[0]).toMatchObject({
      workbook: { status: "invalid" },
    });
    const activeCancellation = new AbortController();
    const pending = inspectWorkbook({
      bytes: Buffer.from(await bomb.xlsx.writeBuffer()),
      signal: activeCancellation.signal,
    });
    activeCancellation.abort(new Error("Cancelled active inspection"));
    await expect(pending).rejects.toThrow(/Cancelled active/);
    const cancellation = new AbortController();
    cancellation.abort(new Error("Cancelled by owner"));
    await expect(
      inspectWorkbook({
        bytes: Buffer.from("irrelevant"),
        signal: cancellation.signal,
      }),
    ).rejects.toThrow(/Cancelled/);
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});
