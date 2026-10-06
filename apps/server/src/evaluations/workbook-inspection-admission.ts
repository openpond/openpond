import type { TasksetPackage } from "openpond-sdk/taskset-packages";
import {
  workbookProbeSheets,
  XLSX_MEDIA_TYPE,
} from "./workbook-inspection-contract.js";

/** Reject an unsupported inspection/output contract before policy dispatch. */
export function assertWorkbookInspectionAdmission(value: TasksetPackage): void {
  const probes = workbookProbeSheets(value.taskset.metadata);
  let workbooks = 0;
  for (const task of value.taskset.tasks) {
    if ((task.requiredOutputs?.length ?? 0) > 16)
      throw new Error(
        "This evaluator admits at most 16 retained outputs per case.",
      );
    for (const output of task.requiredOutputs ?? []) {
      if (output.mediaType !== XLSX_MEDIA_TYPE) continue;
      workbooks++;
      if (output.maxBytes === null || output.maxBytes > 10_000_000)
        throw new Error(
          "Workbook grading requires an output contract bounded to 10 MB.",
        );
    }
  }
  if (probes.length && !workbooks)
    throw new Error(
      "The workbook probe plan requires an actual XLSX output contract.",
    );
}
