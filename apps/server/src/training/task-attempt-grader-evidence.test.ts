import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { TaskAttemptResult } from "@openpond/contracts";
import { describe, expect, test } from "vitest";

import type { SqliteStore } from "../store/store.js";
import { loadTaskAttemptGraderEvidence } from "./task-attempt-grader-evidence.js";

const execFileAsync = promisify(execFile);

describe("task attempt grader evidence", () => {
  test("extracts bounded text and structure from Open XML artifacts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "openpond-grader-evidence-"));
    try {
      await mkdir(path.join(root, "word"));
      await writeFile(
        path.join(root, "word", "document.xml"),
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<w:document xmlns:w="urn:test"><w:body>',
          '<w:p><w:r><w:t>Quarterly operating review</w:t></w:r></w:p>',
          '<w:p><w:r><w:t>Revenue increased by 12 percent.</w:t></w:r></w:p>',
          '</w:body></w:document>',
        ].join(""),
      );
      const artifactPath = path.join(root, "review.docx");
      await execFileAsync("zip", ["-q", "-r", artifactPath, "word"], { cwd: root });
      const store = {
        listTaskAttemptArtifacts: async () => [{
          id: "artifact-1",
          kind: "output_artifact",
          path: artifactPath,
          mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          sha256: "a".repeat(64),
          sizeBytes: 1_000,
          metadata: { requiredOutputPath: "review.docx" },
        }],
      } as unknown as SqliteStore;
      const evidence = await loadTaskAttemptGraderEvidence({
        store,
        attempt: { id: "attempt-1" } as TaskAttemptResult,
      });
      expect(evidence).toHaveLength(1);
      expect(evidence[0]).toMatchObject({
        extraction: "open_xml_text",
        requiredOutputPath: "review.docx",
        structure: {
          archiveEntryCount: 2,
          extractedEntryCount: 1,
        },
      });
      expect(evidence[0]?.content).toContain("Quarterly operating review");
      expect(evidence[0]?.content).toContain("Revenue increased by 12 percent.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
