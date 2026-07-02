import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createOpenPondServer } from "../apps/server/dist/index.js";

describe("server web surface", () => {
  let root;
  let instance;

  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "openpond-web-surface-"));
    const webRoot = path.join(root, "web");
    await mkdir(path.join(webRoot, "assets"), { recursive: true });
    await writeFile(path.join(webRoot, "index.html"), '<div id="root"></div><script src="./assets/app.js"></script>');
    await writeFile(path.join(webRoot, "assets", "app.js"), "window.__openpondTest = true;");
    instance = await createOpenPondServer({
      port: 0,
      storeDir: path.join(root, "store"),
      webRoot,
      silent: true,
    });
  });

  after(async () => {
    await instance?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  test("serves built web assets without taking over API routes", async () => {
    const rootResponse = await fetch(`${instance.url}/`);
    assert.equal(rootResponse.status, 200);
    assert.match(rootResponse.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await rootResponse.text(), /id="root"/);

    const assetResponse = await fetch(`${instance.url}/assets/app.js`);
    assert.equal(assetResponse.status, 200);
    assert.match(assetResponse.headers.get("content-type") ?? "", /javascript/);
    assert.match(assetResponse.headers.get("cache-control") ?? "", /immutable/);
    assert.match(await assetResponse.text(), /__openpondTest/);

    const healthResponse = await fetch(`${instance.url}/health`);
    assert.equal(healthResponse.status, 200);
    assert.equal((await healthResponse.json()).server, "openpond-app-server");

    const apiResponse = await fetch(`${instance.url}/v1/bootstrap`);
    assert.equal(apiResponse.status, 401);
  });

  test("falls back to index.html for browser routes", async () => {
    const response = await fetch(`${instance.url}/settings`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /id="root"/);
  });
});
