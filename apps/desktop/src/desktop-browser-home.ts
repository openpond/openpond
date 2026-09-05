import { assertStorageAncestors, protectPrivateDirectory } from "@openpond/persistence";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const ReceiptSchema = z.object({
  schemaVersion: z.literal("openpond.nativeBrowserMigration.v1"),
  status: z.enum(["prepared", "committed"]), source: z.string(), destination: z.string(),
  stage: z.string().regex(/^\.chromium-[a-f0-9-]+$/),
  files: z.array(z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), sizeBytes: z.number().int().nonnegative() }).strict()),
}).strict();
type Receipt = z.infer<typeof ReceiptSchema>;

/** Called before Electron is ready, while the launcher's old profile lock is held. */
export function prepareDesktopBrowserHome(home: string, previousUserData: string): { userData: string; sourceBrowserState?: string } {
  const browser = path.join(home, "browser"), userData = path.join(browser, "chromium");
  const metadata = path.join(previousUserData, "browser-sidebar-state.json"), journal = path.join(browser, "native-migration.json");
  assertStorageAncestors(browser);
  mkdirSync(browser, { recursive: true, mode: 0o700 });
  protectPrivateDirectory(browser);
  if (lstatSync(browser).isSymbolicLink()) throw new Error("Native browser storage cannot be a symbolic link.");
  try {
    if (existsSync(journal)) {
      const receipt = ReceiptSchema.parse(JSON.parse(readFileSync(journal, "utf8")));
      if (receipt.destination !== userData) throw new Error("Browser migration destination does not match this home.");
      if (receipt.status === "prepared") finish(receipt, browser, journal);
    } else if (!existsSync(userData) && existsSync(previousUserData) && path.resolve(previousUserData) !== path.resolve(userData)) {
      const stageName = `.chromium-${randomUUID()}`, stage = path.join(browser, stageName);
      let prepared = false;
      try {
        cpSync(previousUserData, stage, { recursive: true, errorOnExist: true, force: false,
          filter: (source) => !/^(Singleton.*|lockfile|DevToolsActivePort)$/.test(path.basename(source)),
        });
        const files = inventory(stage);
        for (const entry of files) {
          if (entry.sha256 !== digest(path.join(previousUserData, entry.path))) throw new Error(`Browser profile changed during migration: ${entry.path}`);
        }
        const receipt: Receipt = { schemaVersion: "openpond.nativeBrowserMigration.v1", status: "prepared", source: previousUserData, destination: userData, stage: stageName, files };
        saveReceipt(journal, receipt); prepared = true;
        finish(receipt, browser, journal);
      } finally { if (!prepared) rmSync(stage, { recursive: true, force: true }); }
    }
  } catch (cause) {
    throw new Error("The native browser profile could not be migrated. Its original folder and recovery journal are preserved; close other OpenPond windows and retry.", { cause });
  }
  mkdirSync(userData, { recursive: true, mode: 0o700 });
  if (lstatSync(userData).isSymbolicLink()) throw new Error("Native browser storage cannot be a symbolic link.");
  return { userData, ...(existsSync(metadata) ? { sourceBrowserState: metadata } : {}) };
}

function finish(receipt: Receipt, browser: string, journal: string): void {
  const stage = path.join(browser, receipt.stage), source = existsSync(receipt.destination) ? receipt.destination : stage;
  // Compare the complete tree, including names, before permitting the engine to mutate it.
  const actual = inventory(source);
  if (JSON.stringify(actual) !== JSON.stringify(receipt.files)) throw new Error("Prepared browser profile does not match its recovery manifest.");
  if (source === stage) renameSync(stage, receipt.destination);
  flush(browser);
  saveReceipt(journal, { ...receipt, status: "committed" });
}
function inventory(root: string): Receipt["files"] {
  const files: Receipt["files"] = [];
  function visit(directory: string): void {
    if (lstatSync(directory).isSymbolicLink()) throw new Error("Browser profile contains a symbolic link.");
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) { files.push({ path: path.relative(root, file), sha256: digest(file), sizeBytes: lstatSync(file).size }); flush(file); }
      else throw new Error(`Browser profile contains a special file: ${entry.name}`);
    }
    flush(directory);
  }
  visit(root); return files;
}
function saveReceipt(file: string, receipt: Receipt): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(receipt), { flag: "wx", mode: 0o600 });
    flush(temporary); renameSync(temporary, file); flush(path.dirname(file));
  } finally { rmSync(temporary, { force: true }); }
}
function flush(file: string): void {
  const stat = lstatSync(file), windows = process.platform === "win32";
  if (windows && stat.isDirectory()) return;
  const readonlyCopy = windows && !(stat.mode & 0o200);
  if (readonlyCopy) chmodSync(file, stat.mode | 0o200);
  try {
    const descriptor = openSync(file, windows ? "r+" : "r");
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  } finally { if (readonlyCopy) chmodSync(file, stat.mode); }
}
function digest(file: string): string {
  const hash = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024), descriptor = openSync(file, "r");
  try { let bytes: number; while ((bytes = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes)); }
  finally { closeSync(descriptor); }
  return hash.digest("hex");
}
