import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electron = path.join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electron.cmd" : "electron",
);
const probe = String.raw`
  const { DatabaseSync } = require("node:sqlite");
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE proof (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  database.prepare("INSERT INTO proof (value) VALUES (?)").run("electron-node-sqlite");
  const row = database.prepare("SELECT value FROM proof WHERE id = ?").get(1);
  database.close();
  process.stdout.write(JSON.stringify({
    electron: process.versions.electron,
    node: process.versions.node,
    value: row?.value,
  }));
`;

const result = spawnSync(electron, ["-e", probe], {
  cwd: root,
  encoding: "utf8",
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
  },
});

if (result.status !== 0) {
  throw new Error(`Electron runtime probe failed: ${result.stderr || result.stdout}`);
}

const outputLine = result.stdout.trim().split(/\r?\n/).at(-1);
if (!outputLine) throw new Error("Electron runtime probe returned no output");
const output = JSON.parse(outputLine) as {
  electron?: string;
  node?: string;
  value?: string;
};
if (output.electron !== "43.1.1") {
  throw new Error(`Expected Electron 43.1.1, received ${output.electron ?? "unknown"}`);
}
if (output.node !== "24.18.0") {
  throw new Error(`Expected embedded Node 24.18.0, received ${output.node ?? "unknown"}`);
}
if (output.value !== "electron-node-sqlite") {
  throw new Error(`Electron node:sqlite round-trip failed: ${JSON.stringify(output)}`);
}

console.log(JSON.stringify(output));
