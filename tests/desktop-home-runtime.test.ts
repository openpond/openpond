import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { createReadyLineParser } from "@openpond/runtime";
import { stopOwnedProcessTree } from "../apps/desktop/src/desktop-backend-manager";
import { recoverDesktopHomeRuntime, isOrphanedMacDesktopCommand } from "../apps/desktop/src/desktop-home-runtime";

// A second app must reconnect to the actual home owner on its ephemeral port;
// a tampered endpoint or incompatible runtime must never become its renderer.
test("recovers the registered runtime over a real authenticated process boundary", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "openpond-home-runtime-"));
  const child = spawn(process.execPath, ["-e", `
    const fs = require('node:fs');
    const path = require('node:path');
    const home = process.argv[1];
    const server = require('node:http').createServer((req, res) => {
      if (req.url === '/health') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ok:true,server:'openpond-app-server',version:'1.0.0'}));
      }
      if (req.url === '/v1/configuration') {
        res.statusCode = req.headers.authorization === 'Bearer fixture-token' ? 200 : 401;
        return res.end('{}');
      }
      res.setHeader('Content-Type', 'text/html'); res.end('<html>OpenPond</html>');
    });
    server.listen(0, '127.0.0.1', () => {
      const url = 'http://127.0.0.1:' + server.address().port;
      fs.mkdirSync(path.join(home, 'runtime'));
      fs.writeFileSync(path.join(home,'runtime','server-owner.lock'),JSON.stringify({pid:process.pid,nonce:'fixture'}));
      fs.writeFileSync(path.join(home,'runtime','endpoint.json'),JSON.stringify({schemaVersion:'openpond.runtimeEndpoint.v1',pid:process.pid,url,serverId:'fixture'}));
      console.log('READY ' + JSON.stringify({url}));
    });
  `, home], { detached: process.platform !== "win32", stdio: "pipe" });
  child.stdin.end();
  try {
    const serverUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Runtime fixture did not start")), 5_000);
      const parser = createReadyLineParser<{ url: string }>("READY ", (record) => { clearTimeout(timer); resolve(record.url); });
      child.stdout.on("data", (chunk) => parser.push(String(chunk)));
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    const input = { home, token: "fixture-token", desktopVersion: "1.0.0" };
    await expect(recoverDesktopHomeRuntime(input)).resolves.toEqual({ serverUrl, token: "fixture-token" });
    await expect(recoverDesktopHomeRuntime({ ...input, desktopVersion: "2.0.0" })).rejects.toThrow("version 1.0.0");
    await expect(recoverDesktopHomeRuntime({ ...input, token: "wrong" })).rejects.toThrow("already owns");
    const file = path.join(home, "runtime", "endpoint.json");
    const endpoint = JSON.parse(await fs.readFile(file, "utf8"));
    for (const change of [{ url: "https://example.com:1234" }, { pid: child.pid! + 1 }, { url: serverUrl + "/redirect" }]) {
      await fs.writeFile(file, JSON.stringify({ ...endpoint, ...change }));
      await expect(recoverDesktopHomeRuntime(input)).rejects.toThrow("already owns");
    }
  } finally {
    await stopOwnedProcessTree(child);
    await fs.rm(home, { recursive: true, force: true });
  }
  await expect(recoverDesktopHomeRuntime({ home, desktopVersion: "1.0.0", token: null })).resolves.toBeNull();
});

// Automatic retirement must never terminate a live app's backend or a CLI runtime.
test("recognizes only orphaned Mac desktop server processes from the same app bundle", () => {
  const bundle = "/private/var/folders/a/T/AppTranslocation/id/d/openpond.app";
  const command = `${bundle}/Contents/MacOS/openpond ${bundle}/Contents/Resources/server/index.js web --port 0`;
  expect(isOrphanedMacDesktopCommand(`1 ${command}`)).toBe(true);
  expect(isOrphanedMacDesktopCommand(`123 ${command}`)).toBe(false);
  expect(isOrphanedMacDesktopCommand(`1 node /tmp/server/index.js web --port 0`)).toBe(false);
  expect(isOrphanedMacDesktopCommand(`1 ${command.replace(`${bundle}/Contents/Resources`, '/Applications/other.app/Contents/Resources')}`)).toBe(false);
});

// Replacing a .app can leave its server reparented to launchd. Exercise actual
// ps/lsof inspection and termination on Mac, rather than mocking a stale PID.
test.skipIf(process.platform !== "darwin")("retires an orphaned app backend before launching the replacement", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "openpond-orphan-"));
  const bundle = path.join(home, "openpond.app");
  const executable = path.join(bundle, "Contents", "MacOS", "openpond");
  const entry = path.join(bundle, "Contents", "Resources", "server", "index.js");
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.mkdir(path.dirname(entry), { recursive: true });
  await fs.symlink(process.execPath, executable);
  await fs.writeFile(entry, `
    const fs = require('node:fs'), path = require('node:path');
    const home = process.argv.at(-1);
    const server = require('node:http').createServer((req,res) => {
      if(req.url === '/health') return res.end(JSON.stringify({ok:true,server:'openpond-app-server',version:'1.0.0'}));
      res.statusCode = req.headers.authorization === 'Bearer fixture-token' ? 200 : 401;
      res.end('{}');
    });
    server.listen(0,'127.0.0.1',()=>{
      fs.mkdirSync(path.join(home,'runtime'));
      fs.writeFileSync(path.join(home,'runtime','server-owner.lock'),JSON.stringify({pid:process.pid,nonce:'orphan'}));
      fs.writeFileSync(path.join(home,'runtime','endpoint.json'),JSON.stringify({schemaVersion:'openpond.runtimeEndpoint.v1',pid:process.pid,url:'http://127.0.0.1:'+server.address().port,serverId:'orphan'}));
    });
  `);
  let orphanPid: number | null = null;
  try {
    const launcher = spawn(process.execPath, ["-e", `
      const child=require('node:child_process').spawn(process.argv[1],[process.argv[2],'web','--port','0','--home',process.argv[3]],{detached:true,stdio:'ignore'});
      child.unref();
    `, executable, entry, home], { stdio: "ignore" });
    await new Promise<void>((resolve,reject) => { launcher.once("exit",code=>code===0?resolve():reject(new Error("Orphan launcher failed")));launcher.once("error",reject); });
    const endpointFile = path.join(home, "runtime", "endpoint.json");
    for (let tries = 0; tries < 100; tries += 1) {
      try { orphanPid = JSON.parse(await fs.readFile(endpointFile, "utf8")).pid; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 25)); }
    }
    expect(orphanPid).toBeGreaterThan(0);
    await expect(recoverDesktopHomeRuntime({home,desktopVersion:"2.0.0",token:"fixture-token"})).resolves.toBeNull();
    expect(() => process.kill(orphanPid!, 0)).toThrow();
  } finally {
    if (orphanPid) { try { process.kill(orphanPid,"SIGKILL"); } catch {} }
    await fs.rm(home, {recursive:true,force:true});
  }
}, 15_000);
