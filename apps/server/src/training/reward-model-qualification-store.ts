import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  RewardModelQualificationReportSchema,
  type RewardModelQualificationReport,
  verifyRewardModelQualificationReport,
} from "@openpond/evals";
import { contentHash } from "@openpond/harness";

function reportPath(storeDir: string, id: string): string {
  const digest = contentHash({ id });
  return path.join(storeDir, "reward-model-qualification-reports", `${digest}.json`);
}

export async function saveRewardModelQualificationReport(input: {
  storeDir: string;
  report: RewardModelQualificationReport;
}): Promise<void> {
  const report = RewardModelQualificationReportSchema.parse(input.report);
  if (!verifyRewardModelQualificationReport(report)) {
    throw new Error("Reward Model qualification report content hash is invalid.");
  }
  const destination = reportPath(input.storeDir, report.id);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report)}\n`, "utf8");
  try {
    await rename(temporary, destination);
  } catch (error) {
    const existing = await loadRewardModelQualificationReport({
      storeDir: input.storeDir,
      id: report.id,
      contentHash: report.contentHash,
    });
    if (!existing) throw error;
  }
}

export async function loadRewardModelQualificationReport(input: {
  storeDir: string;
  id: string;
  contentHash: string;
}): Promise<RewardModelQualificationReport | null> {
  try {
    const report = RewardModelQualificationReportSchema.parse(
      JSON.parse(await readFile(reportPath(input.storeDir, input.id), "utf8")),
    );
    if (report.id !== input.id || report.contentHash !== input.contentHash) {
      throw new Error("Reward Model qualification report identity mismatch.");
    }
    if (!verifyRewardModelQualificationReport(report)) {
      throw new Error("Reward Model qualification report content changed.");
    }
    return report;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}
