import { TASK_INTAKE_LIMITS } from "./intake-contracts.js";

/** RFC 4180-style quoting; newlines inside a quoted field remain content. */
export function parseTaskIntakeCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false, closed = false;
  const finishField = () => { row.push(field); field = ""; closed = false; };
  const finishRow = () => {
    finishField();
    if (row.some(value => value.length)) rows.push(row);
    row = [];
    if (rows.length > TASK_INTAKE_LIMITS.records + 1) throw new Error("CSV exceeds the 1,000-record limit.");
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index++; }
      else if (char === '"') { quoted = false; closed = true; }
      else field += char;
    } else if (char === ",") finishField();
    else if (char === "\n" || char === "\r") { if (char === "\r" && text[index + 1] === "\n") index++; finishRow(); }
    else if (char === '"' && !field && !closed) quoted = true;
    else { if (closed || char === '"') throw new Error("CSV has an invalid quoted field."); field += char; }
  }
  if (quoted) throw new Error("CSV has an unterminated quoted field.");
  if (field || row.length || closed) finishRow();
  const header = rows.shift()?.map(value => value.trim().replace(/^\uFEFF/u, ""));
  if (!header?.includes("instruction")) throw new Error("CSV requires an instruction column.");
  const allowed = new Set(["instruction", "context", "reference", "labels", "id", "familyKey", "split"]);
  if (header.some(value => !allowed.has(value)) || new Set(header).size !== header.length) throw new Error("CSV has duplicate or unsupported columns. Use instruction, context, reference, labels, id, familyKey and split.");
  return rows.map((values, index) => {
    if (values.length !== header.length) throw new Error(`CSV record ${index + 2} has a different number of columns from its header.`);
    return Object.fromEntries(header.map((name, column) => [name, values[column]!]).filter(([, value]) => value !== ""));
  });
}
