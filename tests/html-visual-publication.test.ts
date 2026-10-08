import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SessionSchema, type RuntimeEvent } from "@openpond/contracts";
import { createHtmlVisualService } from "../apps/server/src/visuals/visual-service";
import { visualTools } from "../apps/server/src/visuals/visual-tools";
import { createTaskCoordinationMcp } from "../apps/server/src/runtime/task-inbox/codex-mcp";
import { nativeToolMcpResult } from "../apps/server/src/openpond/native-tool-calls";
import type { BrowserHarnessToolExecutor } from "../apps/server/src/openpond/browser-tool-registry";
import { buildChatMessages } from "../apps/web/src/lib/chat-messages";

// A text-only MCP conversion, interrupted publication, or cross-session revision
// could silently lose a checked visual. Exercise those boundaries in one flow.
it("delivers preview pixels through MCP and recovers one immutable, owned publication", async () => {
  const home = await mkdtemp(join(tmpdir(), "openpond-visual-"));
  const workspace = join(home, "workspace"); await mkdir(workspace);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7n8AAAAASUVORK5CYII=", "base64");
  await writeFile(join(workspace, "chart.png"), png);
  await writeFile(join(home, "secret.png"), png);
  await symlink(join(home, "secret.png"), join(workspace, "escape.png"));
  const session = SessionSchema.parse({ id: "a", title: "Visual", provider: "claude-code", experience: "development", appId: null, appName: null, cwd: workspace, codexThreadId: null, createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z", status: "idle", pinned: false, archived: false, order: 0 });
  const other = { ...session, id: "b" };
  const events: RuntimeEvent[] = [];
  let failAppend = true, exists = true, errors = false;
  const rendered: string[] = [];
  const executor = { available: () => true, visualAvailable: () => true, previewHtml: async (input: { html: string }) => {
    rendered.push(input.html);
    return { ok: true, action: "html_preview", output: "Captured", data: { screenshots: [png.toString("base64"), png.toString("base64")], heights: [{ width: 680, height: 220 }, { width: 360, height: 310 }], console: errors ? [{ level: "error", text: "broken script" }] : [] } };
  } } as unknown as BrowserHarnessToolExecutor;
  const deps = { home, executor, getSession: async (id: string) => exists ? id === "a" ? session : other : null, events: async () => events,
    append: async (event: RuntimeEvent) => { if (failAppend) throw new Error("simulated interruption"); events.push(event); } };
  let service = createHtmlVisualService(deps);
  const context = { session, turnId: "turn-a", callId: "preview", signal: new AbortController().signal };
  const definitions = visualTools(service);
  const mcp = await createTaskCoordinationMcp({ tools: definitions.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })),
    execute: async (name, args, callId, signal) => nativeToolMcpResult(await definitions.find(tool => tool.name === name)!.execute({ ...context, args, callId, signal } as Parameters<typeof definitions[number]["execute"]>[0])) });
  try {
    const response = await fetch(mcp.config.url, { method: "POST", headers: { ...mcp.config.http_headers, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "html_preview", arguments: { html: '<img src="asset:chart"><p>Checked</p>', assets: [{ name: "chart", path: "chart.png" }] } } }) });
    const result = (await response.json()).result;
    expect(result.content[1]).toEqual({ type: "image", mimeType: "image/png", data: png.toString("base64") });
    expect(result.content).toHaveLength(3);
    const receipt = JSON.parse(result.content[0].text);
    expect(events).toHaveLength(0);
    await expect(service.render({ ...context, session: other }, { previewId: receipt.previewId, title: "Stolen" })).rejects.toThrow("another conversation");
    await expect(service.preview(context, { html: "<img>", assets: [{ name: "x", path: "escape.png" }] })).rejects.toThrow("outside");
    await expect(service.render({ ...context, callId: "invalid-title" }, { previewId: receipt.previewId, title: "Bad\nTitle" })).rejects.toThrow("single-line");
    const publish = { previewId: receipt.previewId, title: "Comparison" };
    await expect(service.render({ ...context, callId: "publish" }, publish)).rejects.toThrow("interruption");
    failAppend = false;
    service = createHtmlVisualService(deps); await service.recover();
    const ref = await service.render({ ...context, callId: "publish" }, publish);
    expect(events).toHaveLength(1);
    await rm(join(workspace, "chart.png"));
    const saved = await service.read("a", ref.publicationId);
    expect(saved.bytes.toString()).toBe(rendered[0]);
    expect(saved.bytes.toString()).toContain(`data:image/png;base64,${png.toString("base64")}`);
    await expect(service.read("b", ref.publicationId)).rejects.toThrow("unavailable");
    const revision = await service.preview(context, { html: "<p>Revised</p>" });
    const revised = await service.render({ ...context, turnId: "turn-b", callId: "revise" }, { previewId: revision.previewId, title: "Comparison", visualId: ref.visualId });
    expect(revised.output.revision).toBe(2); expect(revised.visualId).toBe(ref.visualId);
    expect((await service.read("a", ref.publicationId)).bytes).toEqual(saved.bytes);
    const rows = buildChatMessages([...events, ...events]);
    expect(rows.map(row => row.visual?.output.revision)).toEqual([1, 2]);
    errors = true;
    const broken = await service.preview(context, { html: "<p>Broken</p>" });
    await expect(service.render({ ...context, callId: "broken" }, { previewId: broken.previewId, title: "Broken" })).rejects.toThrow("script or resource errors");
    exists = false; await service.recover();
    await expect(service.read("a", revised.publicationId)).rejects.toThrow("unavailable");
  } finally { await mcp.close(); await rm(home, { recursive: true, force: true }); }
});
