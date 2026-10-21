import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { updateConfig } from "@openpond/persistence";
import type { BrowserHarnessToolExecutor } from "../apps/server/src/openpond/browser-tool-registry";
import { createTurnRunnerTestHarness, turnRunnerTestSession } from "./helpers/turn-runner-test-harness";

function browserExecutor(available: () => boolean) {
  const snapshot = vi.fn<BrowserHarnessToolExecutor["snapshot"]>(async () => ({
    ok: true, action: "openpond_browser_snapshot", output: "Snapshot from the desktop browser.",
  }));
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected browser action"); };
  const executor: BrowserHarnessToolExecutor = {
    available, snapshot, open: unexpected, moveCursor: unexpected, click: unexpected,
    typeText: unexpected, pressKey: unexpected, scroll: unexpected,
  };
  return { executor, snapshot };
}

// Failure story: registering browser tools in the hosted catalog alone leaves
// Claude with no browser despite a connected desktop. Exercise the actual CLI
// launch and HTTP MCP boundary, including reconnect/resume and chat isolation.
test.skipIf(process.platform === "win32")("Claude receives and executes the desktop browser tools after reconnecting", async () => {
  const home = await mkdtemp(join(tmpdir(), "openpond-native-browser-"));
  const executable = join(home, "claude");
  await writeFile(executable, `#!${process.execPath}\n` + String.raw`
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const configIndex = process.argv.indexOf('--mcp-config');
const server = configIndex < 0 ? null : Object.values(JSON.parse(process.argv[configIndex + 1]).mcpServers)[0];
let requestId = 0;
async function rpc(method, params = {}) {
  const response = await fetch(server.url, { method: 'POST', headers: {...server.headers, 'Content-Type': 'application/json'},
    body: JSON.stringify({jsonrpc:'2.0', id:++requestId, method, params}) });
  const payload = await response.json();
  if(payload.error) throw new Error(payload.error.message);
  return payload.result;
}
require('node:readline').createInterface({input:process.stdin}).on('line', async line => {
  const input = JSON.parse(line);
  if(input.type === 'control_request') {
    send({type:'control_response', response:{subtype:'success', request_id:input.request_id, response:{}}});
    return;
  }
  if(input.type !== 'user') return;
  try {
    const tools = server ? (await rpc('tools/list')).tools : [];
    const names = tools.map(tool => tool.name);
    const snapshot = names.includes('openpond_browser_snapshot')
      ? await rpc('tools/call', {name:'openpond_browser_snapshot', arguments:{includeScreenshot:false}}) : null;
    if(snapshot?.isError) throw new Error(JSON.stringify(snapshot));
    const preview = await rpc('tools/call', {name:'openpond_show_file', arguments:{path:require('node:path').join(__dirname, 'Preview deck.pdf')}});
    if(preview.isError) throw new Error(JSON.stringify(preview));
    send({type:'result', session_id:input.session_id, is_error:false, result:JSON.stringify({names, snapshot})});
  } catch(error) {
    send({type:'result', session_id:input.session_id, is_error:true, errors:[String(error)]});
  }
  send({type:'system', subtype:'session_state_changed', state:'idle'});
});
`, { mode: 0o700 });
  await writeFile(join(home, "Preview deck.pdf"), "%PDF-1.4\npreview\n%%EOF");
  await updateConfig(home, document => ({ ...document, providers: {
    "claude-code": { enabled: true, binary_path: executable, source_home: home },
  } }));
  let connected = false;
  const browser = browserExecutor(() => connected);
  const session = turnRunnerTestSession({ provider: "claude-code", modelRef: { providerId: "claude-code", modelId: "default" },
    experience: "work", cwd: home });
  const internal = { ...session, id: "internal-chat", experience: "chat" as const };
  const harness = createTurnRunnerTestHarness({ sessions: [session, internal], dependencies: {
    storageHome: home, attachmentRootDir: home, browserToolExecutor: browser.executor,
  } });
  const sendTurn = async (id: string) => {
    const turn = await harness.runner.sendTurn(id, { prompt: "Inspect the in-app browser.", modelRef: session.modelRef });
    expect(turn.error).toBeNull();
    expect(turn.status).toBe("completed");
    const output = harness.state.events.findLast(event => event.turnId === turn.id && event.name === "assistant.delta")!.output!;
    return { turn, result: JSON.parse(output) as { names: string[]; snapshot: unknown } };
  };
  try {
    const offline = await sendTurn(session.id);
    expect(offline.result.names.filter(name => name.startsWith("openpond_browser_"))).toEqual([]);
    const nativeSessionId = harness.state.sessions.get(session.id)!.nativeAgent!.sessionId;
    connected = true;
    const online = await sendTurn(session.id);
    expect(online.result.names).toEqual(expect.arrayContaining([
      "openpond_browser_open", "openpond_browser_snapshot", "openpond_browser_move_cursor",
      "openpond_browser_click", "openpond_browser_type", "openpond_browser_key", "openpond_browser_scroll",
    ]));
    expect(online.result.snapshot).toBeTruthy();
    expect(harness.state.events.filter(event => event.turnId === online.turn.id && event.name === "file.preview_requested"))
      .toEqual([expect.objectContaining({ sessionId: session.id, source: "server", data: { target: "local", path: join(home, "Preview deck.pdf"), source: false } })]);
    expect(harness.state.sessions.get(session.id)!.nativeAgent!.sessionId).toBe(nativeSessionId);
    expect(browser.snapshot).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      sessionId: session.id, conversationId: session.id, turnId: online.turn.id,
    }));
    const restricted = await sendTurn(internal.id);
    expect(restricted.result.names.filter(name => name.startsWith("openpond_browser_"))).toEqual([]);
    expect(browser.snapshot).toHaveBeenCalledTimes(1);
  } finally {
    await harness.runner.close();
    await rm(home, { recursive: true, force: true });
  }
});

// Codex has a separate native branch; it must route the same tools to the
// current conversation rather than silently omitting them from its bridge.
test("Codex routes browser actions through its conversation-bound native bridge", async () => {
  const home = await mkdtemp(join(tmpdir(), "openpond-codex-preview-"));
  await writeFile(join(home, "Preview deck.pdf"), "%PDF-1.4\npreview\n%%EOF");
  const browser = browserExecutor(() => true);
  const session = turnRunnerTestSession({ provider: "codex", modelRef: { providerId: "codex", modelId: "gpt-6.1-sol" },
    experience: "work", cwd: home, workspaceKind: "local_project" });
  const harness = createTurnRunnerTestHarness({ sessions: [session], dependencies: {
    browserToolExecutor: browser.executor,
    ensureCodexRuntime: async (_session, input) => ({ threadId: "native-thread", cwd: session.cwd, permissionMode: "default", reasoningEffort: null,
      client: { startTurn: async () => {
        expect(input.coordination!.tools.some(tool => tool.name === "openpond_browser_snapshot")).toBe(true);
        await input.coordination!.execute("openpond_browser_snapshot", {}, "browser-read", new AbortController().signal);
        await input.coordination!.execute("openpond_show_file", { path: "Preview deck.pdf" }, "preview-file", new AbortController().signal);
        return { turnId: "native-turn" };
      }, waitForTurn: async () => {}, stopAndWait: async () => {} } as never,
    }),
  } });
  try {
    const turn = await harness.runner.sendTurn(session.id, { prompt: "Inspect the browser.", modelRef: session.modelRef });
    expect(turn.error).toBeNull();
    expect(turn.status).toBe("completed");
    expect(browser.snapshot).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      sessionId: session.id, conversationId: session.id, turnId: turn.id,
    }));
    expect(harness.state.events.filter(event => event.name === "file.preview_requested"))
      .toEqual([expect.objectContaining({ sessionId: session.id, turnId: turn.id, data: { target: "local", path: join(home, "Preview deck.pdf"), source: false } })]);
  } finally { await harness.runner.close(); await rm(home, { recursive: true, force: true }); }
});
