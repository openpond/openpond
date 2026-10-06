import { parentPort, workerData } from "node:worker_threads";
import ExcelJS from "exceljs";
import yauzl from "yauzl";
import { initSync, Model } from "@ironcalc/wasm";
import { workbookEngineBinary } from "./workbook-engine-binary.js";
import {
  WORKBOOK_INSPECTION_MAX_RESULT_BYTES,
  type WorkbookInspection,
  type WorkbookValue,
} from "./workbook-inspection-contract.js";

const result: WorkbookInspection = {
  schemaVersion: "openpond.workbookInspection.v1",
  engine: "ironcalc-0.8.4",
  status: "invalid",
  errors: [],
  sheets: [],
  probes: [],
};

/** Inflate each entry once with actual byte accounting before ExcelJS loads it.
 * Declared ZIP sizes alone do not bound decompression or XML allocation. */
async function qualifyZip(bytes: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    yauzl.fromBuffer(
      bytes,
      { lazyEntries: true, validateEntrySizes: true },
      (error, zip) => {
        if (error || !zip) {
          reject(new Error("Invalid XLSX ZIP container."));
          return;
        }
        let total = 0,
          entries = 0;
        const names = new Set<string>();
        const fail = (error: Error) => {
          zip.close();
          reject(error);
        };
        zip.on("error", fail);
        zip.on("end", () =>
          names.has("xl/workbook.xml") && names.has("[Content_Types].xml")
            ? resolve()
            : reject(new Error("Missing XLSX workbook parts.")),
        );
        zip.on("entry", (entry) => {
          const name = entry.fileName;
          if (
            ++entries > 512 ||
            names.has(name) ||
            name.startsWith("/") ||
            name.split("/").includes("..") ||
            entry.generalPurposeBitFlag & 1 ||
            /vbaProject|externalLinks|embeddings\//i.test(name)
          ) {
            fail(new Error("Unsupported or unsafe XLSX package entry."));
            return;
          }
          names.add(name);
          if (name.endsWith("/")) {
            zip.readEntry();
            return;
          }
          if (entry.uncompressedSize > 8_000_000) {
            fail(new Error("XLSX part exceeds its expansion limit."));
            return;
          }
          zip.openReadStream(entry, (error, stream) => {
            if (error || !stream) {
              fail(new Error("Unreadable XLSX package entry."));
              return;
            }
            let size = 0;
            const chunks: Buffer[] = [];
            stream.on("error", fail);
            stream.on("data", (chunk: Buffer) => {
              size += chunk.length;
              total += chunk.length;
              if (size > 8_000_000 || total > 32_000_000) {
                stream.destroy();
                fail(new Error("XLSX exceeds its expansion limit."));
                return;
              }
              if (/\.xml$|\.rels$/i.test(name)) chunks.push(chunk);
            });
            stream.on("end", () => {
              const text = Buffer.concat(chunks).toString("utf8");
              if (
                /<!DOCTYPE|<!ENTITY|TargetMode\s*=\s*["']External["']/i.test(
                  text,
                )
              ) {
                fail(
                  new Error(
                    "XLSX external resources or XML entities are unsupported.",
                  ),
                );
                return;
              }
              zip.readEntry();
            });
          });
        });
        zip.readEntry();
      },
    ),
  );
}

function primitive(value: ExcelJS.CellValue | undefined): WorkbookValue {
  if (value == null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite workbook value.");
    return value;
  }
  if (typeof value === "boolean" || typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if ("richText" in value)
    return value.richText.map((part) => part.text).join("");
  if ("text" in value) return value.text;
  if ("error" in value) return value.error;
  throw new Error("Unsupported workbook cell value.");
}

async function inspect(): Promise<void> {
  const bytes = Buffer.from(workerData.bytes as Uint8Array),
    probeSheets = workerData.probeSheets as string[];
  await qualifyZip(bytes);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  if (!book.worksheets.length || book.worksheets.length > 16)
    throw new Error("Workbook sheet limit exceeded.");
  initSync({ module: workbookEngineBinary });
  const model = new Model("retained-workbook", "en", "UTC", "en");
  try {
    model.pauseEvaluation();
    for (let index = 0; index < book.worksheets.length; index++) {
      if (index) model.newSheet();
      model.renameSheet(index, book.worksheets[index]!.name);
    }
    let count = 0,
      formulas = 0,
      textBytes = 0;
    const formulaCells: {
      sheet: number;
      row: number;
      column: number;
      address: string;
    }[] = [];
    const numericInputs: {
      sheet: number;
      row: number;
      column: number;
      address: string;
      value: number;
    }[] = [];
    for (const [index, sheet] of book.worksheets.entries()) {
      const cells: WorkbookInspection["sheets"][number]["cells"] = [];
      if (sheet.rowCount > 10_000 || sheet.columnCount > 256)
        throw new Error("Workbook dimensions exceed inspection limits.");
      sheet.eachRow((row) =>
        row.eachCell((cell) => {
          if (cell.type === ExcelJS.ValueType.Merge) return;
          if (++count > 4_000) throw new Error("Workbook cell limit exceeded.");
          const formula = cell.formula || null;
          if (
            formula &&
            (++formulas > 1_000 ||
              formula.includes("[") ||
              formula.length > 4_000 ||
              /\b(?:NOW|TODAY|RAND|RANDBETWEEN|WEBSERVICE|RTD)\s*\(/i.test(
                formula,
              ))
          )
            throw new Error(
              "Unsupported, volatile or excessive workbook formulas.",
            );
          const cachedValue = primitive(formula ? cell.result : cell.value);
          textBytes +=
            Buffer.byteLength(String(cachedValue ?? "")) +
            Buffer.byteLength(formula ?? "");
          if (textBytes > 250_000)
            throw new Error("Workbook text limit exceeded.");
          const protection = (
            sheet as unknown as { sheetProtection?: { sheet?: boolean } }
          ).sheetProtection;
          const editable =
            !protection?.sheet || cell.protection.locked === false;
          cells.push({
            address: cell.address,
            row: cell.fullAddress.row,
            column: Number(cell.col),
            value: cachedValue,
            formula,
            cachedValue,
            editable,
          });
          const value = cell.value;
          const numericDate =
            value instanceof Date
              ? value.getTime() / 86_400_000 +
                (book.properties.date1904 ? 24_107 : 25_569)
              : null;
          model.setUserInput(
            index,
            cell.fullAddress.row,
            Number(cell.col),
            formula
              ? `=${formula}`
              : numericDate !== null
                ? String(numericDate)
                : typeof cachedValue === "string"
                  ? `'${cachedValue}`
                  : cachedValue === null
                    ? ""
                    : String(cachedValue),
          );
          if (formula) {
            model.updateRangeStyle(
              {
                sheet: index,
                row: cell.fullAddress.row,
                column: Number(cell.col),
                width: 1,
                height: 1,
              },
              "num_fmt",
              "0.000000000000000",
            );
            formulaCells.push({
              sheet: index,
              row: cell.fullAddress.row,
              column: Number(cell.col),
              address: cell.address,
            });
          } else if (
            typeof cachedValue === "number" &&
            editable &&
            probeSheets.includes(sheet.name)
          ) {
            numericInputs.push({
              sheet: index,
              row: cell.fullAddress.row,
              column: Number(cell.col),
              address: cell.address,
              value: cachedValue,
            });
          }
        }),
      );
      result.sheets.push({
        name: sheet.name,
        hidden: sheet.state !== "visible",
        cells,
      });
    }
    if (numericInputs.length > 64)
      throw new Error("Workbook input probe limit exceeded.");
    // ExcelJS preserves named ranges; provide them to the calculation engine.
    if (book.definedNames.model.length > 128)
      throw new Error("Workbook defined-name limit exceeded.");
    for (const name of book.definedNames.model) {
      if (
        name.name.length > 100 ||
        name.ranges.some((range) => range.length > 500)
      )
        throw new Error("Workbook defined-name length limit exceeded.");
      if (name.name.startsWith("_xlnm.")) continue;
      if (name.ranges.length !== 1)
        throw new Error(
          "Multi-area named ranges are unsupported for workbook grading.",
        );
      model.newDefinedName(name.name, null, `=${name.ranges[0]}`);
    }
    model.resumeEvaluation();
    model.evaluate();
    function calculated(cell: (typeof formulaCells)[number]): WorkbookValue {
      const type = model.getCellType(cell.sheet, cell.row, cell.column);
      const text = model.getFormattedCellValue(
        cell.sheet,
        cell.row,
        cell.column,
      );
      if (type === 16)
        throw new Error(
          `Formula error at ${result.sheets[cell.sheet]!.name}!${cell.address}: ${text}`,
        );
      if (type === 1) {
        const number = Number(text);
        if (!Number.isFinite(number))
          throw new Error("Invalid recalculated number.");
        return number;
      }
      if (type === 4) return text === "TRUE";
      return text || null;
    }
    const baseline = formulaCells.map(calculated);
    model.evaluate();
    if (
      formulaCells.some((cell, index) => calculated(cell) !== baseline[index])
    )
      throw new Error("Workbook calculations are not deterministic.");
    formulaCells.forEach((cell, index) => {
      result.sheets[cell.sheet]!.cells.find(
        (value) => value.address === cell.address,
      )!.value = baseline[index]!;
    });
    for (const input of numericInputs) {
      const after = input.value + Math.max(1, Math.abs(input.value) * 0.01);
      model.setUserInput(input.sheet, input.row, input.column, String(after));
      model.evaluate();
      const changed: WorkbookInspection["probes"][number]["changed"] = [];
      for (const [index, cell] of formulaCells.entries()) {
        const value = calculated(cell);
        if (value !== baseline[index])
          changed.push({
            sheet: result.sheets[cell.sheet]!.name,
            address: cell.address,
            before: baseline[index]!,
            after: value,
          });
      }
      result.probes.push({
        sheet: result.sheets[input.sheet]!.name,
        address: input.address,
        before: input.value,
        after,
        changed,
      });
      model.setUserInput(
        input.sheet,
        input.row,
        input.column,
        String(input.value),
      );
      model.evaluate();
    }
    for (const name of probeSheets)
      if (!result.sheets.some((sheet) => sheet.name === name))
        throw new Error(`Missing workbook probe sheet: ${name}`);
    result.status = "inspected";
  } finally {
    model.free();
  }
}

void inspect()
  .catch((error) => {
    result.status = "invalid";
    result.errors = [
      error instanceof Error
        ? error.message.slice(0, 500)
        : "Invalid workbook.",
    ];
  })
  .then(() => {
    let serialized = JSON.stringify(result);
    if (Buffer.byteLength(serialized) > WORKBOOK_INSPECTION_MAX_RESULT_BYTES)
      serialized = JSON.stringify({
        ...result,
        status: "invalid",
        sheets: [],
        probes: [],
        errors: ["Workbook inspection evidence limit exceeded."],
      });
    parentPort!.postMessage(serialized);
  });
