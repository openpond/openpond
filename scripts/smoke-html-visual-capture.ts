import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// A valid PNG and correct dimensions do not prove a hidden window painted after
// resizing. Check real Electron pixels below its initial 100px viewport, at both
// preview widths, including the app background behind transparent author content.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(path.join(tmpdir(), "openpond-visual-capture-"));
try {
  const entry = path.join(scratch, "capture.cjs");
  await build({
    stdin: { contents: `
      import { app, BrowserWindow, nativeImage } from 'electron';
      import assert from 'node:assert/strict';
      import { captureHtmlVisual } from './apps/desktop/src/desktop-html-preview';
      app.setPath('userData', ${JSON.stringify(path.join(scratch, "profile"))});
      // CI runs under Xvfb without a reliable GPU compositor.
      if (process.env.CI) app.disableHardwareAcceleration();
      void app.whenReady().then(async () => {
        const owner = new BrowserWindow({show:false});
        try {
          await owner.loadURL('data:text/html,<style>:root{--surface-page:rgb(80,80,80)}.app-shell{--surface-page:rgb(20,20,20)}</style><main class=app-shell></main>');
          const result = await captureHtmlVisual({id:'pixel-check',operation:'previewHtml',
            deadlineAt:new Date(Date.now()+15000).toISOString(),input:{width:680,
            html:'<style>body{background:transparent}</style><div style="height:50px"></div><div style="height:600px;background:rgb(10,100,200)"></div>'}},owner,new AbortController().signal);
          assert.equal(result.screenshots.length,2);
          assert.deepEqual(result.console,[]);
          result.screenshots.forEach((png,index) => {
            const image = nativeImage.createFromBuffer(Buffer.from(png,'base64')).resize({width:result.heights[index].width,height:650});
            assert.equal(result.heights[index].height,650);
            assert.equal(result.heights[index].width,index===0?680:360);
            const bytes=image.toBitmap(), width=image.getSize().width;
            const pixel=(x,y)=>[...bytes.subarray((y*width+x)*4,(y*width+x)*4+4)];
            assert.deepEqual(pixel(20,20),[20,20,20,255],'Transparent content must use the app background');
            assert.deepEqual(pixel(20,620),[200,100,10,255],'The lower content must be painted after resizing');
          });
          console.log('HTML visual capture pixels passed at 680px and 360px');
        } finally { owner.destroy(); }
      }).then(()=>app.exit(0),error=>{console.error(error);app.exit(1)});
    `, resolveDir: root, loader: "ts" },
    bundle: true, platform: "node", format: "cjs", external: ["electron"], outfile: entry,
  });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  await new Promise<void>((resolve, reject) => {
    // Match the existing desktop smoke launcher on restricted Linux CI runners.
    // This process renders only the fixed pixel fixture, never user documents.
    const args = process.env.CI ? ["--no-sandbox", entry] : [entry];
    const child = spawn(createRequire(import.meta.url)("electron") as string, args, { cwd: root, env, stdio: "inherit" });
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("HTML visual capture timed out")); }, 30_000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`HTML visual capture exited ${code}`)); });
  });
} finally {
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
