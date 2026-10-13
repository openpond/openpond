import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { SessionSchema, TurnSchema } from "@openpond/contracts";
import { SqliteStore } from "../store/store.js";
import { createChatCliInvocation } from "./chat-cli-invocation.js";

// Failure story: model-written IDs, another server's token, or a completed
// turn must never grant authority to attach CLI output to a different chat.
test("CLI association capabilities bind to their process and live owning turn", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "openpond-cli-context-"));
  const store = new SqliteStore(home);
  try {
    for (const id of ["one", "two"]) await store.insertSessionAtFront(SessionSchema.parse({ id, provider: "codex", title: id,
      appId:null,appName:null,cwd:null,codexThreadId:null,pinned:false,archived:false,order:0,
      createdAt:"2026-10-01T00:00:00.000Z",updatedAt:"2026-10-01T00:00:00.000Z",status:"idle" }));
    await store.insertTurn(TurnSchema.parse({ id:"turn",sessionId:"one",providerTurnId:null,prompt:"List datasets",
      startedAt:"2026-10-01T00:00:00.000Z",completedAt:null,status:"in_progress",error:null }));
    const context = createChatCliInvocation(store);
    const token = await context.issue("one", "turn");
    expect(await context.resolve(token)).toEqual({sessionId:"one",turnId:"turn"});
    const [body, signature] = token.split(".");
    const changed = JSON.parse(Buffer.from(body!,"base64url").toString()); changed.sessionId="two";
    await expect(context.resolve(`${Buffer.from(JSON.stringify(changed)).toString("base64url")}.${signature}`)).rejects.toThrow("Invalid");
    await expect(createChatCliInvocation(store).resolve(token)).rejects.toThrow("Invalid");
    await expect(context.issue("two", "turn")).rejects.toThrow("unavailable");
    await store.updateTurn("turn", turn=>({...turn,status:"completed"}));
    await expect(context.resolve(token)).rejects.toThrow("unavailable");
  } finally { await store.close(); await rm(home,{recursive:true,force:true}); }
});
