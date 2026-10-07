import { get } from "node:http";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createHtmlPreviewService } from "../apps/server/src/workspace/html-preview.js";

// Executable HTML must load its relative assets without gaining access to hidden
// files, symlink escapes, other directories, or the application's authenticated origin.
it("serves a capability-scoped HTML preview and relative assets on a separate origin", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpond-html-"));
  const previews = createHtmlPreviewService();
  try {
    const repo = join(root, "repo");
    await mkdir(join(repo, "slides"), { recursive: true });
    await writeFile(join(repo, "slides", "deck.html"), '<script src="../main.js"></script>');
    await writeFile(join(repo, "main.js"), "window.ready = true;");
    await writeFile(join(repo, ".env"), "SECRET=private");
    await writeFile(join(repo, ".private.json"), "private");
    await symlink(join(repo, ".private.json"), join(repo, "hidden.json"));
    await writeFile(join(root, "private.json"), '"private"');
    await writeFile(join(root, "output.html"), "outside output");
    await symlink(join(root, "private.json"), join(repo, "escape.json"));
    const { url } = await previews.open(repo, "slides/deck.html#page=2", false);
    expect(new URL(url).hostname).toBe("127.0.0.1");
    expect((await fetch(url)).headers.get("content-type")).toBe("text/html");
    expect(await (await fetch(new URL("../main.js", url))).text()).toContain("window.ready");
    expect((await fetch(url, { method: "HEAD" })).status).toBe(200);
    for (const asset of ["../.env", "../escape.json", "../hidden.json", "../../private.json", "../%2eenv", "../%2fetc%2fpasswd"]) {
      expect((await fetch(new URL(asset, url))).status).toBe(404);
    }
    expect((await fetch(url, { method: "POST" })).status).toBe(404);
    expect(await new Promise<number | undefined>((resolve, reject) => { const request = get(url, { headers: { Host: "attacker.test" } }, (response) => { response.resume(); resolve(response.statusCode); }); request.on("error", reject); })).toBe(404);
    await expect(previews.open(repo, "../output.html", true)).rejects.toThrow("outside");
    await expect(previews.open(repo, join(root, "output.html"), false)).rejects.toThrow("outside");
    const output = await previews.open(repo, join(root, "output.html"), true);
    expect(await (await fetch(output.url)).text()).toBe("outside output");
    const content = await previews.openContent("attachment.html", "<h1>Attached</h1>");
    expect(await (await fetch(content.url)).text()).toContain("Attached");
    expect((await fetch(new URL("main.js", content.url))).status).toBe(404);
    const remoteReads: string[] = [];
    const remote = await previews.openRemote("slides/deck.html", async (asset) => {
      remoteReads.push(asset);
      return Buffer.from(asset === "slides/deck.html" ? '<script src="../assets/chart.js"></script>' : 'chart();');
    });
    expect(await (await fetch(new URL("../assets/chart.js", remote.url))).text()).toBe("chart();");
    expect((await fetch(new URL("../../secret.json", remote.url))).status).toBe(404);
    expect(remoteReads).toEqual(["slides/deck.html", "assets/chart.js"]);
    await previews.close();
    await expect(fetch(url)).rejects.toThrow();
  } finally { await previews.close(); await rm(root, { recursive: true, force: true }); }
});
