import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { CdpClient } from "../scripts/desktop-harness/cdp";
import { htmlVisualDocument } from "../packages/contracts/src/html-visual-document";

const chromePath = process.env.OPENPOND_TEST_CHROME ?? "/usr/bin/google-chrome";
const hasChrome = await access(chromePath).then(() => true, () => false);
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// Real Chromium must run author interactions while denying parent access and
// every network path, including navigation after the author removes its CSP.
it.skipIf(!hasChrome)("isolates executable visual content and propagates bounded dynamic height", async () => {
  const dir = await mkdtemp(`${tmpdir()}/openpond-visual-browser-`);
  const requests: string[] = [];
  const server = createServer((req, res) => { requests.push(req.url!); res.end("unexpected network access"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  const chrome = spawn(chromePath, ["--headless=new", "--disable-extensions", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let chromeError = "";
  chrome.stderr.on("data", chunk => { chromeError = (chromeError + String(chunk)).slice(-2000); });
  let cdp: CdpClient | undefined;
  try {
    let port = "";
    for (let attempt = 0; attempt < 100; attempt++) {
      port = await readFile(`${dir}/DevToolsActivePort`, "utf8").then(value => value.split("\n")[0]!, () => "");
      if (port) break;
      if (chrome.exitCode !== null) break;
      await delay(200);
    }
    if (!port) throw new Error(`Chromium failed to start: ${chromeError}`);
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
    cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
    const evaluate = async (expression: string) => (await cdp!.send<{ result: { value: any } }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
    const load = async (html: string) => {
      await cdp!.send("Page.navigate", { url: `data:text/html,${encodeURIComponent(htmlVisualDocument(html, "boundary"))}` });
      for (let i = 0; i < 30; i++) { if (await evaluate("window.__openpondVisual?.ready")) return; await delay(100); }
      throw new Error("Visual did not load");
    };
    await load(`<button style="display:block;width:160px;height:60px" onclick="document.querySelector('section').style.height='380px';console.log('clicked')">Expand</button><section style="height:160px">Content</section><script>try{parent.document.body;console.log('parent readable')}catch{console.log('parent denied')}try{localStorage.setItem('secret','x');console.log('storage available')}catch{console.log('storage denied')}console.log(typeof window.openpond,typeof require)</script>`);
    expect(await evaluate("window.__openpondVisual.height")).toBe(220);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 60, y: 25, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 60, y: 25, button: "left", clickCount: 1 });
    await delay(300);
    const state = await evaluate("window.__openpondVisual");
    expect(state.height).toBe(440);
    expect(state.console.map((row: { text: string }) => row.text)).toEqual(expect.arrayContaining(["parent denied", "storage denied", "undefined undefined", "clicked"]));
    // A spoofed size notification from the wrong window must be ignored.
    await evaluate("postMessage({type:'openpond-size',identity:'boundary',height:99999},'*')");
    await delay(100); expect(await evaluate("window.__openpondVisual.height")).toBe(440);
    // Lazy mounting near the viewport edge must not wait for animation frames:
    // the initial 80px child can be fully clipped even when its host is visible.
    await cdp.send("Page.navigate", { url: "data:text/html,<body></body>" });
    await evaluate(`(() => { window.measuredHeight=0; addEventListener('message', e => { if(e.data?.type==='openpond-visual-size')window.measuredHeight=e.data.height; }); const f=document.createElement('iframe');f.setAttribute('sandbox','allow-scripts');f.style.cssText='position:fixed;top:-300px;width:680px;height:640px';f.srcdoc=${JSON.stringify(htmlVisualDocument('<section style="height:640px">Clipped top</section>', "clipped"))};document.body.append(f); })()`);
    for (let i=0; i<30 && await evaluate("window.measuredHeight") !== 640; i++) await delay(100);
    expect(await evaluate("window.measuredHeight")).toBe(640);
    await load(`<p>Network probe</p><img src="${url}/image"><iframe src="${url}/nested"></iframe><style>@import url('${url}/style');</style><script>fetch('${url}/fetch').catch(()=>{});navigator.sendBeacon('${url}/beacon','x');try{new Worker('${url}/worker')}catch{};window.open('${url}/popup');setTimeout(()=>{document.querySelectorAll('meta').forEach(e=>e.remove());location.href='${url}/navigate'},150)</script>`);
    await delay(600);
    expect(requests).toEqual([]);
  } finally {
    await cdp?.send("Browser.close").catch(() => undefined);
    cdp?.close();
    const exited = chrome.exitCode === null ? once(chrome, "exit") : Promise.resolve();
    chrome.kill(); await Promise.race([exited, delay(3000).then(() => chrome.kill("SIGKILL"))]);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
