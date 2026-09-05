import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { prepareDesktopBrowserHome } from "../apps/desktop/src/desktop-browser-home";

// A file-copy test cannot detect a profile that Chromium can no longer decrypt or open.
// Exercise a persistent cookie and localStorage through separate real engine lifetimes.
const execute = promisify(execFile);
const electron = createRequire(import.meta.url)("electron") as string;
const directory = await mkdtemp(path.join(os.tmpdir(), "openpond-browser-migration-"));
const source = path.join(directory, "previous"), home = path.join(directory, "home");
const probe = path.join(directory, "probe.cjs");
await writeFile(probe, String.raw`
const { app, session, BrowserWindow } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
app.setPath("userData", process.env.PROBE_PROFILE);
const timer = setTimeout(() => { console.error("Engine probe timed out"); app.exit(1); }, 25000);
app.whenReady().then(async () => {
  const server = http.createServer((_request, response) => response.end("<title>Storage proof</title>"));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + server.address().port;
  const storage = session.fromPartition("persist:migration-proof");
  const window = new BrowserWindow({ show: false, webPreferences: { session: storage, sandbox: true } });
  await window.loadURL(url);
  if (process.env.PROBE_MODE === "seed") {
    await storage.cookies.set({ url, name: "preserved-login", value: "synthetic-session", expirationDate: Date.now() / 1000 + 86400 });
    await window.webContents.executeJavaScript('localStorage.setItem("saved-choice", "preserved")');
  }
  const cookies = await storage.cookies.get({ name: "preserved-login" });
  // localStorage is origin-specific, so read the seed origin again on subsequent processes.
  const originFile = process.env.PROBE_ORIGIN;
  if (process.env.PROBE_MODE === "seed") fs.writeFileSync(originFile, url);
  else {
    server.close();
    const port = Number(new URL(fs.readFileSync(originFile, "utf8")).port);
    await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
    await window.loadURL("http://127.0.0.1:" + port);
  }
  const choice = await window.webContents.executeJavaScript('localStorage.getItem("saved-choice")');
  await storage.cookies.flushStore();
  storage.flushStorageData();
  if (cookies.length !== 1 || cookies[0].value !== "synthetic-session" || choice !== "preserved") throw new Error("Native session or local storage was lost");
  window.destroy(); server.close(); clearTimeout(timer); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
`);
async function run(profile: string, mode: "seed" | "read") {
  const env = { ...process.env, PROBE_PROFILE: profile, PROBE_MODE: mode, PROBE_ORIGIN: path.join(directory, "origin") };
  delete env.ELECTRON_RUN_AS_NODE;
  await execute(electron, ["--no-sandbox", "--disable-gpu", probe], { env, timeout: 30_000 });
}
try {
  await run(source, "seed");
  const migrated = prepareDesktopBrowserHome(home, source);
  await run(migrated.userData, "read");
  await run(prepareDesktopBrowserHome(home, source).userData, "read");
  await run(source, "read");
  const receipt = JSON.parse(await readFile(path.join(home, "browser", "native-migration.json"), "utf8"));
  if (receipt.status !== "committed") throw new Error("Native migration did not commit");
  console.log(`Electron browser migration passed on ${process.platform}: cookie, localStorage, restart and original profile.`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
