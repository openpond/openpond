/** Trusted inspection of retained bytes; never populated from the policy reply. */
export type WorkbookValue = string | number | boolean | null;
export type WorkbookCell = {
  address: string;
  row: number;
  column: number;
  value: WorkbookValue;
  formula: string | null;
  cachedValue: WorkbookValue;
  editable: boolean;
};
export type WorkbookInspection = {
  schemaVersion: "openpond.workbookInspection.v1";
  engine: "ironcalc-0.8.4";
  status: "inspected" | "invalid";
  errors: string[];
  sheets: { name: string; hidden: boolean; cells: WorkbookCell[] }[];
  probes: {
    sheet: string;
    address: string;
    before: number;
    after: number;
    changed: {
      sheet: string;
      address: string;
      before: WorkbookValue;
      after: WorkbookValue;
    }[];
  }[];
};
export const XLSX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const WORKBOOK_INSPECTION_MAX_RESULT_BYTES = 1_000_000;

export function workbookProbeSheets(
  metadata: Record<string, unknown> | undefined,
): string[] {
  const value = metadata?.artifactInspection;
  if (value === undefined) return [];
  if (
    !value ||
    typeof value !== "object" ||
    !("workbookProbeSheets" in value) ||
    !Array.isArray(value.workbookProbeSheets) ||
    value.workbookProbeSheets.length > 16 ||
    value.workbookProbeSheets.some(
      (name) => typeof name !== "string" || !name.trim() || name.length > 100,
    ) ||
    new Set(value.workbookProbeSheets).size !== value.workbookProbeSheets.length
  ) {
    throw new Error("The released workbook inspection plan is invalid.");
  }
  return value.workbookProbeSheets as string[];
}
