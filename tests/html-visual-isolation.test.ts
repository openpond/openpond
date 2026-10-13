import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { CdpClient } from "../scripts/desktop-harness/cdp";
import { htmlVisualDocument } from "../packages/contracts/src/html-visual-document";
import { PNG } from "pngjs";

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
  const chromeEnv = { ...process.env };
  // Headless CI has no desktop session bus or reliable shared-memory/GPU
  // compositor. Keep browser startup separate from the isolation assertions.
  delete chromeEnv.DBUS_SESSION_BUS_ADDRESS;
  const chrome = spawn(chromePath, ["--headless=new", "--disable-gpu", "--disable-dev-shm-usage", "--disable-extensions", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "about:blank"], { env: chromeEnv, stdio: ["ignore", "ignore", "pipe"] });
  let chromeError = "";
  chrome.stderr.on("data", chunk => { chromeError = (chromeError + String(chunk)).slice(-2000); });
  let cdp: CdpClient | undefined;
  try {
    let port = "";
    for (let attempt = 0; attempt < 225; attempt++) {
      port = await readFile(`${dir}/DevToolsActivePort`, "utf8").then(value => value.split("\n")[0]!, () => "");
      if (port) break;
      if (chrome.exitCode !== null) break;
      await delay(200);
    }
    if (!port) throw new Error(`Chromium failed to start (exit ${chrome.exitCode ?? "pending"}): ${chromeError}`);
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
    cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
    const evaluate = async (expression: string) => (await cdp!.send<{ result: { value: any } }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
    const load = async (html: string) => {
      await cdp!.send("Page.navigate", { url: `data:text/html,${encodeURIComponent(htmlVisualDocument(html, "boundary"))}` });
      for (let i = 0; i < 30; i++) {
        if (await evaluate("window.__openpondVisual?.ready")) {
          // The ready message can precede the frame's first paint. Native
          // mouse input must wait until Chromium has committed its hit targets.
          await cdp!.send("Page.bringToFront");
          await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
          return;
        }
        await delay(100);
      }
      throw new Error("Visual did not load");
    };
    await load(`<button style="display:block;width:160px;height:60px" onclick="document.querySelector('section').style.height='380px';console.log('clicked')">Expand</button><section style="height:160px">Content</section><script>try{parent.document.body;console.log('parent readable')}catch{console.log('parent denied')}try{localStorage.setItem('secret','x');console.log('storage available')}catch{console.log('storage denied')}console.log(typeof window.openpond,typeof require)</script>`);
    expect(await evaluate("window.__openpondVisual.height")).toBe(220);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 60, y: 25, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 60, y: 25, button: "left", clickCount: 1 });
    for (let i = 0; i < 30 && await evaluate("window.__openpondVisual.height") !== 440; i++) await delay(100);
    const state = await evaluate("window.__openpondVisual");
    expect(state.height).toBe(440);
    expect(state.console.map((row: { text: string }) => row.text)).toEqual(expect.arrayContaining(["parent denied", "storage denied", "undefined undefined", "clicked"]));
    // A spoofed size notification from the wrong window must be ignored.
    await evaluate("postMessage({type:'openpond-size',identity:'boundary',height:99999},'*')");
    await delay(100); expect(await evaluate("window.__openpondVisual.height")).toBe(440);
    // Lazy mounting near the viewport edge must not wait for animation frames:
    // the initial 80px child can be fully clipped even when its host is visible.
    await cdp.send("Page.navigate", { url: "data:text/html,<body id=clipped-host></body>" });
    for (let i=0; i<30 && !await evaluate("!!document.getElementById('clipped-host')"); i++) await delay(100);
    expect(await evaluate("!!document.getElementById('clipped-host')")).toBe(true);
    await evaluate(`(() => { window.measuredHeight=0; addEventListener('message', e => { if(e.data?.type==='openpond-visual-size')window.measuredHeight=e.data.height; }); const f=document.createElement('iframe');f.setAttribute('sandbox','allow-scripts');f.style.cssText='position:fixed;top:-300px;width:680px;height:640px';f.srcdoc=${JSON.stringify(htmlVisualDocument('<section style="height:640px">Clipped top</section>', "clipped"))};document.body.append(f); })()`);
    for (let i=0; i<30 && await evaluate("window.measuredHeight") !== 640; i++) await delay(100);
    expect(await evaluate("window.measuredHeight")).toBe(640);
    await load(`<p>Network probe</p><img src="${url}/image"><iframe src="${url}/nested"></iframe><style>@import url('${url}/style');</style><script>fetch('${url}/fetch').catch(()=>{});navigator.sendBeacon('${url}/beacon','x');try{new Worker('${url}/worker')}catch{};window.open('${url}/popup');setTimeout(()=>{document.querySelectorAll('meta').forEach(e=>e.remove());location.href='${url}/navigate'},150)</script>`);
    await delay(600);
    expect(requests).toEqual([]);
    // Failure story: selecting a resource button for a screenshot must not
    // trigger its action, and exported DOM must preserve live form state while
    // stripping executable handlers before the isolated image renderer sees it.
    await cdp.send("Page.navigate", { url: "data:text/html,<body id=snapshot-host></body>" });
    for (let i = 0; i < 30 && !await evaluate("!!document.getElementById('snapshot-host')"); i++) await delay(100);
    const snapshotHtml = '<button id="probe" style="width:160px;height:60px" data-openpond-resource-kind="dataset" data-openpond-resource-id="examples" data-openpond-resource-revision="1" onclick="document.querySelector(\'output\').textContent=\'acted\'">Select resource</button><input value="initial"><output>untouched</output><svg width="200" height="100" viewBox="0 0 200 100" style="display:block;margin-left:300px;margin-top:40px"><defs><linearGradient id="tone"><stop stop-color="#00aa77"/><stop offset="1" stop-color="#00aa77"/></linearGradient></defs><rect id="shape" x="30" y="20" width="60" height="40" fill="url(about:srcdoc#tone)" /></svg><script>document.querySelector("input").value="edited"</script>';
    await evaluate(`(() => {window.snapshotReady=false;window.resourceSelections=0;addEventListener('message',e=>{if(e.data?.type==='openpond-visual-size'&&e.data.ready)window.snapshotReady=true;if(e.data?.type==='openpond-visual-snapshot')window.captureResult=e.data;if(e.data?.type==='openpond-visual-snapshot-ready')window.pickerReady=e.data.requestId;if(e.data?.type==='openpond-visual-resource-select')window.resourceSelections++});const frame=document.createElement('iframe');frame.style.cssText='position:fixed;left:0;top:0;width:680px;height:600px;border:0';frame.setAttribute('sandbox','allow-scripts');frame.srcdoc=${JSON.stringify(htmlVisualDocument(snapshotHtml, "snapshot-test"))};document.body.append(frame)})()`);
    for (let i = 0; i < 30 && !await evaluate("window.snapshotReady"); i++) await delay(100);
    expect(await evaluate("window.snapshotReady")).toBe(true);
    const command = async (action: string, requestId: string) => {
      await evaluate(`document.querySelector('iframe').contentWindow.postMessage({type:'openpond-snapshot-command',identity:'snapshot-test',action:${JSON.stringify(action)},requestId:${JSON.stringify(requestId)}},'*')`);
      if (action !== "node") return;
      for (let i = 0; i < 50 && await evaluate("window.pickerReady") !== requestId; i++) await delay(100);
      expect(await evaluate("window.pickerReady")).toBe(requestId);
      await cdp!.send("Page.bringToFront");
      await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    };
    await command("node", "node-test");
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 50, y: 25 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 50, y: 25, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 50, y: 25, button: "left", clickCount: 1 });
    for (let i = 0; i < 30 && !await evaluate("window.captureResult"); i++) await delay(100);
    const selected = await evaluate("window.captureResult");
    expect(selected.requestId).toBe("node-test");
    expect(selected.capture.rect).toEqual({ x: 0, y: 0, width: 160, height: 60 });
    expect(selected.capture.html).not.toContain("onclick=");
    expect(await evaluate("window.resourceSelections")).toBe(0);
    await command("page", "page-test");
    for (let i = 0; i < 30 && await evaluate("window.captureResult?.requestId") !== "page-test"; i++) await delay(100);
    const page = await evaluate("window.captureResult");
    expect(page.capture.html).toContain('value="edited"');
    expect(page.capture.html).toContain("untouched");
    expect(page.capture.html).not.toContain("<script");
    await command("node", "cancel-test"); await command("cancel", "cancel-test");
    for (let i = 0; i < 30 && await evaluate("window.captureResult?.requestId") !== "cancel-test"; i++) await delay(100);
    expect(await evaluate("window.captureResult.canceled")).toBe(true);
    await command("node", "svg-test");
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 350, y: 130 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 350, y: 130, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 350, y: 130, button: "left", clickCount: 1 });
    for (let i = 0; i < 30 && await evaluate("window.captureResult?.requestId") !== "svg-test"; i++) await delay(100);
    const svgResult = await evaluate("window.captureResult");
    expect(svgResult).toMatchObject({ requestId: "svg-test" });
    expect(svgResult.error).toBeUndefined();
    const svg = svgResult.capture;
    expect(svg.selector).toBe("rect#shape");
    await cdp.send("Page.navigate", { url: `data:text/html,${encodeURIComponent(`<body style="margin:0">${svg.html}</body>`)}` });
    for (let i = 0; i < 30 && !await evaluate("!!document.querySelector('svg')"); i++) await delay(100);
    const screenshot = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 60, height: 40, scale: 1 } });
    const pixels = PNG.sync.read(Buffer.from(screenshot.data, "base64"));
    expect([...pixels.data.subarray((20 * pixels.width + 30) * 4, (20 * pixels.width + 30) * 4 + 4)]).toEqual([0, 170, 119, 255]);
  } finally {
    await cdp?.send("Browser.close").catch(() => undefined);
    cdp?.close();
    const exited = chrome.exitCode === null ? once(chrome, "exit") : Promise.resolve();
    chrome.kill(); await Promise.race([exited, delay(3000).then(() => chrome.kill("SIGKILL"))]);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
