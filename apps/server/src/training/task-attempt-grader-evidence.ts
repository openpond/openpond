import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import type { TaskAttemptResult } from "@openpond/contracts";
import type { ModelJudgeRunner } from "@openpond/taskset-sdk";

import type { SqliteStore } from "../store/store.js";
import { executableSearchPath } from "../runtime/executable-search-path-bun-compat.js";
import { parseModelJudgeResult } from "../server-entry-helpers.js";
import type { createTrainingModelRuntime } from "./training-model-runtime.js";
import { hostedTokenPricingFromValue } from "./hosted-token-pricing.js";

const MAX_ARTIFACTS = 5;
const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const MAX_EXTRACTED_CHARS = 40_000;
const execFileAsync = promisify(execFile);

type TrainingModelText = ReturnType<
  typeof createTrainingModelRuntime
>["trainingModelText"];

export function createTaskAttemptModelJudge(input: {
  store: SqliteStore;
  modelText: TrainingModelText;
}): ModelJudgeRunner {
  return async ({ grader, task, attempt }) => {
    const usages: unknown[] = [];
    let costUsd = 0;
    const artifactEvidence = await loadTaskAttemptGraderEvidence({
      store: input.store,
      attempt,
    });
    const hostedTokenPricing =
      attempt.modelRef?.providerId === grader.judge.providerId
      && attempt.modelRef.modelId === grader.judge.modelId
        ? hostedTokenPricingFromValue(attempt.metadata.hostedTokenPricing)
          ?? undefined
        : undefined;
    const raw = await input.modelText({
      model: grader.judge,
      hostedTokenPricing,
      signal: new AbortController().signal,
      requestId: `task-judge:${attempt.id}:${grader.id}`,
      onUsage: (usage, cost) => {
        usages.push(usage);
        if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
          costUsd += cost;
        }
      },
      messages: [
        {
          role: "system",
          content: `Apply this rubric and return JSON only with score (0..1), passed, and feedback.\n\n${grader.rubric}`,
        },
        {
          role: "user",
          content: JSON.stringify({
            input: task.input,
            policyVisibleContext: task.policyVisibleContext,
            output: attempt.output,
            artifactEvidence,
            evaluationCriteria: task.evaluationCriteria,
          }),
        },
      ],
    });
    const parsed = parseModelJudgeResult(raw);
    if (!parsed) throw new Error("Model judge returned invalid structured output.");
    return {
      ...parsed,
      usage: usages,
      ...(costUsd > 0 ? { costUsd } : {}),
    };
  };
}

export async function loadTaskAttemptGraderEvidence(input: {
  store: SqliteStore;
  attempt: TaskAttemptResult;
}): Promise<Array<Record<string, unknown>>> {
  const artifacts = (await input.store.listTaskAttemptArtifacts({
    attemptId: input.attempt.id,
  }))
    .filter((artifact) => artifact.kind === "output_artifact")
    .slice(0, MAX_ARTIFACTS);
  return Promise.all(artifacts.map(async (artifact) => {
    const base = {
      artifactId: artifact.id,
      mediaType: artifact.mediaType ?? null,
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
      requiredOutputPath:
        typeof artifact.metadata.requiredOutputPath === "string"
          ? artifact.metadata.requiredOutputPath
          : null,
    };
    if (artifact.sizeBytes > MAX_ARTIFACT_BYTES) {
      return { ...base, extraction: "omitted", reason: "artifact exceeds inspection bound" };
    }
    try {
      if (artifact.mediaType === "application/pdf") {
        const { stdout } = await execFileAsync("pdftotext", [artifact.path, "-"], {
          env: { ...process.env, PATH: executableSearchPath() },
          maxBuffer: 8 * 1024 * 1024,
          timeout: 15_000,
        });
        return {
          ...base,
          extraction: "pdf_text",
          content: boundedText(stdout),
        };
      }
      if (isOpenXmlArtifact(artifact.mediaType)) {
        const extracted = await extractOpenXmlArtifact(
          artifact.path,
          artifact.mediaType!,
        );
        return {
          ...base,
          extraction: "open_xml_text",
          content: boundedText(extracted.content),
          structure: extracted.structure,
        };
      }
      if (isTextArtifact(artifact.mediaType)) {
        return {
          ...base,
          extraction: "text",
          content: boundedText(await readFile(artifact.path, "utf8")),
        };
      }
      return { ...base, extraction: "metadata_only" };
    } catch (error) {
      return {
        ...base,
        extraction: "unavailable",
        reason: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      };
    }
  }));
}

function isTextArtifact(mediaType: string | null | undefined): boolean {
  return Boolean(
    mediaType?.startsWith("text/")
      || mediaType === "application/json"
      || mediaType === "application/javascript"
      || mediaType === "application/sql"
      || mediaType === "application/xml"
      || mediaType === "application/yaml"
  );
}

function isOpenXmlArtifact(mediaType: string | null | undefined): boolean {
  return mediaType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    || mediaType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    || mediaType === "application/vnd.openxmlformats-officedocument.presentationml.presentation";
}

async function extractOpenXmlArtifact(
  artifactPath: string,
  mediaType: string,
): Promise<{
  content: string;
  structure: Record<string, unknown>;
}> {
  const options = {
    env: { ...process.env, PATH: executableSearchPath() },
    maxBuffer: 16 * 1024 * 1024,
    timeout: 15_000,
  };
  const { stdout: listing } = await execFileAsync(
    "unzip",
    ["-Z1", artifactPath],
    options,
  );
  const entries = listing.split(/\r?\n/).filter(Boolean);
  const selected = openXmlTextEntries(entries, mediaType).slice(0, 250);
  const parts: string[] = [];
  for (const entry of selected) {
    const { stdout } = await execFileAsync(
      "unzip",
      ["-p", artifactPath, entry],
      options,
    );
    const text = readableXmlText(stdout);
    if (text) parts.push(`[${entry}]\n${text}`);
  }
  return {
    content: parts.join("\n\n"),
    structure: {
      archiveEntryCount: entries.length,
      extractedEntryCount: selected.length,
      sheetCount: entries.filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry)).length,
      slideCount: entries.filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry)).length,
      chartCount: entries.filter((entry) => /\/charts\/chart\d+\.xml$/.test(entry)).length,
      imageCount: entries.filter((entry) => /\/media\//.test(entry)).length,
    },
  };
}

function openXmlTextEntries(entries: string[], mediaType: string): string[] {
  if (mediaType.includes("wordprocessingml")) {
    return entries.filter((entry) =>
      /^word\/(?:document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/.test(entry)
    );
  }
  if (mediaType.includes("spreadsheetml")) {
    return entries.filter((entry) =>
      entry === "xl/workbook.xml"
      || entry === "xl/sharedStrings.xml"
      || /^xl\/worksheets\/sheet\d+\.xml$/.test(entry)
      || /^xl\/charts\/chart\d+\.xml$/.test(entry)
    );
  }
  return entries
    .filter((entry) =>
      /^ppt\/(?:slides\/slide\d+|notesSlides\/notesSlide\d+|charts\/chart\d+)\.xml$/.test(entry)
    )
    .sort(naturalEntryOrder);
}

function naturalEntryOrder(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true });
}

function readableXmlText(value: string): string {
  return decodeXmlEntities(
    value
      .replace(/<\/?(?:w:p|a:p|row|si|sheetData|c)(?:\s[^>]*)?>/g, "\n")
      .replace(/<(?:w:tab|a:br)(?:\s[^>]*)?\/?\s*>/g, "\t")
      .replace(/<[^>]+>/g, " "),
  )
    .split(/\r?\n/)
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function boundedText(value: string): string {
  return value.length <= MAX_EXTRACTED_CHARS
    ? value
    : `${value.slice(0, MAX_EXTRACTED_CHARS)}\n[truncated]`;
}
