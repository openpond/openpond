import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { SqliteStore } from "./store.js";
import { createSessionStore } from "./session-store.js";
import { createPonderHistoryRuntime } from "../openpond/ponder-history/runtime.js";
import type { TurnRepository } from "../runtime/turns/ports.js";
import type { HostedChatMessage } from "@openpond/cloud";
// Protects restart recovery, CAS ownership, immutable admission and destination
// rebudgeting together; mocks only the expensive semantic model response.
it("recovers durable summary work and exact admitted requests across restart and model budgets", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "ponder-history-"));
    let store = new SqliteStore(home);
    try {
        const sessions = createSessionStore({ store, defaultSessionCwd: () => home, appendRuntimeEvent: async () => { } });
        const session = await sessions.createSession({ provider: "openai", systemKind: "openpond.ponder", hiddenFromDefaultSidebar: true });
        const historical: HostedChatMessage[] = Array.from({ length: 8 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `Original ${index}: ${"durable exact evidence ".repeat(300)}` }));
        const messages: HostedChatMessage[] = [{ role: "system", content: "Coordinator" }, ...historical, { role: "user", content: "Continue" }];
        const args = { sessionId: session.id, requestId: "request-1", messages, historical, fits: (messages: HostedChatMessage[]) => JSON.stringify(messages).length < 5000 };
        await expect(createPonderHistoryRuntime(store as TurnRepository).prepare({ ...args, summarize: async () => { throw new Error("summary transport lost"); } })).rejects.toThrow("summary transport lost");
        const failed = await store.readPonderHistory(session.id);
        expect(failed.pending.length).toBeGreaterThan(0);
        expect(failed.originals).toHaveLength(8);
        await store.close();
        store = new SqliteStore(home);
        let summaries = 0;
        const admitted = await createPonderHistoryRuntime(store as TurnRepository).prepare({ ...args, summarize: async (_source, address) => { summaries++; return `Retained semantic decision ${address}`; } });
        expect(JSON.stringify(admitted).length).toBeLessThan(5000);
        expect(summaries).toBeGreaterThan(0);
        const snapshot = await store.readPonderHistory(session.id);
        expect(snapshot.originals[0]?.message.content).toBe(historical[0]?.content);
        expect(await store.savePonderHistory(session.id, snapshot.revision - 1, snapshot)).toBe(false);
        const unchanged = await store.admitPonderHistoryRequest("request-1", session.id, [{ role: "user", content: "must not overwrite admitted request" }]);
        expect(unchanged).toEqual(admitted);
        const smaller = await createPonderHistoryRuntime(store as TurnRepository).prepare({ ...args, requestId: "request-2", fits: messages => JSON.stringify(messages).length < 1800, summarize: async () => { throw new Error("completed summaries must survive restart"); } });
        expect(JSON.stringify(smaller).length).toBeLessThan(1800);
        await store.close();
        store = new SqliteStore(home);
        expect(await store.admitPonderHistoryRequest("request-1", session.id, [])).toEqual(admitted);
        expect((await store.readPonderHistory(session.id)).originals).toHaveLength(8);
    }
    finally {
        await store.close();
        await rm(home, { recursive: true, force: true });
    }
});
// A summary may lag behind an already admitted request. A process restart must
// resume that authorized work without waiting for another user conversation turn.
it("admits original history during summary lag and recovers the pending queue at startup", async () => {
    const { createHostedCompactionRuntime } = await import("../runtime/hosted-turn/compaction-runtime.js");
    const { TurnSchema } = await import("@openpond/contracts");
    const home = await mkdtemp(path.join(tmpdir(), "ponder-history-startup-"));
    let store = new SqliteStore(home);
    try {
        const session = await createSessionStore({ store, defaultSessionCwd: () => home, appendRuntimeEvent: async () => { } }).createSession({ provider: "openai", systemKind: "openpond.ponder", hiddenFromDefaultSidebar: true });
        const timestamp = new Date().toISOString();
        await store.insertTurn(TurnSchema.parse({ id: "summary-owner", sessionId: session.id, providerTurnId: null, prompt: "prior turn", startedAt: timestamp, completedAt: timestamp, status: "completed", error: null }));
        let rejectSummary!: (reason: Error) => void;
        const waiting = new Promise<string>((_resolve, reject) => { rejectSummary = reject; });
        const historical: HostedChatMessage[] = [{ role: "user", content: "Exact retained original ".repeat(1100) }];
        const admitted = await createPonderHistoryRuntime(store as TurnRepository).prepare({ sessionId: session.id, requestId: "lagging-request", messages: [...historical, { role: "user", content: "Continue" }], historical, metadata: { provider: "openai", model: "configured-model", maxContextTokens: 128000 }, fits: () => true, summarize: () => waiting });
        expect(admitted.some(message => message.content === historical[0]?.content)).toBe(true);
        expect((await store.readPonderHistory(session.id)).pending).toHaveLength(1);
        rejectSummary(new Error("process lost provider stream"));
        await expect(createPonderHistoryRuntime(store as TurnRepository).recover(session.id, () => waiting)).rejects.toThrow("process lost provider stream");
        await store.close();
        store = new SqliteStore(home);
        let calls = 0;
        const usage: unknown[] = [];
        createHostedCompactionRuntime({ ponderHistoryStore: store as TurnRepository, sessionForPonderHistory: async () => session,
            loadAppPreferences: async () => { throw new Error("startup must not load request preferences"); }, appendRuntimeEvent: async () => { },
            runtimeEventsForSession: async () => [], upsertModelUsageRecord: async (record) => { usage.push(record); },
            throwIfInterrupted: () => { }, interruptedError: () => new Error("interrupted"),
            streamPonderHistorySummary: async function* () { calls++; yield { text: "Retained semantic startup summary" }; yield { usage: { prompt_tokens: 25, completion_tokens: 8, total_tokens: 33 } }; } });
        for (let attempt = 0; attempt < 100 && (await store.readPonderHistory(session.id)).pending.length; attempt++)
            await new Promise(resolve => setTimeout(resolve, 10));
        expect((await store.readPonderHistory(session.id)).pending).toHaveLength(0);
        expect(calls).toBeGreaterThan(0);
        expect(usage.length).toBeGreaterThan(0);
        expect(await store.admitPonderHistoryRequest("lagging-request", session.id, [])).toEqual(admitted);
    }
    finally {
        await store.close();
        await rm(home, { recursive: true, force: true });
    }
});
// A steering message is another role:user inside the current turn. Treating it
// as the turn boundary discards the prompt and a completed native tool exchange.
it("preserves the entire active tool exchange when steering arrives between requests", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "ponder-history-active-"));
    const store = new SqliteStore(home);
    try {
        const session = await createSessionStore({ store, defaultSessionCwd: () => home, appendRuntimeEvent: async () => { } }).createSession({ provider: "openai", systemKind: "openpond.ponder", hiddenFromDefaultSidebar: true });
        const runtime = createPonderHistoryRuntime(store as TurnRepository);
        const args = { sessionId: session.id, turnId: "active-turn", historical: [], initialPrompt: "Initial assignment", fits: () => true, summarize: async () => { throw new Error("no archival work"); } };
        const first = await runtime.prepare({ ...args, requestId: "active-turn:optchat:0:request", messages: [{ role: "system", content: "Coordinator" }, { role: "user", content: "Initial assignment" }, { role: "user", content: "First correction" }] });
        const exchange: HostedChatMessage[] = [{ role: "assistant", content: "Checking exact state", tool_calls: [{ id: "call-1", type: "function", function: { name: "inspect", arguments: "{}" } }] }, { role: "tool", tool_call_id: "call-1", content: "Exact tool result" }, { role: "user", content: "Second correction" }];
        const next = await runtime.prepare({ ...args, requestId: "active-turn:optchat:1:request", messages: [...first, ...exchange] });
        expect(next.slice(-5)).toEqual([{ role: "user", content: "Initial assignment" }, { role: "user", content: "First correction" }, ...exchange]);
    }
    finally {
        await store.close();
        await rm(home, { recursive: true, force: true });
    }
});
// Exact event evidence may contain enormous Unicode tool results. Every tool
// response stays bounded while byte cursors reconstruct the complete original.
it("paginates large raw tool evidence exactly within a physical payload bound", async () => {
    const { ponderHistoryTools } = await import("../openpond/ponder-history/tools.js");
    const source = { id: "tool-evidence", turnId: "prior-turn", name: "tool.completed", output: '🧪"\\\n'.repeat(20000) };
    const state = { revision: 0, originals: [], sourceEvents: [source], summaries: {}, views: {}, pending: [] };
    const tools = ponderHistoryTools({ readPonderHistory: async () => state } as unknown as TurnRepository);
    const tool = tools.find(tool => tool.name === "ponder_history_events")!;
    let offset = 0;
    let restored = "";
    for (;;) {
        const result = await tool.execute({ session: { id: "ponder", systemKind: "openpond.ponder" }, callId: "read", args: { offset, limit: 1 } } as unknown as import("../openpond/model-tool-registry.js").ModelToolExecutionContext);
        expect(Buffer.byteLength(result.contentText)).toBeLessThan(12000);
        const data = result.data as {
            text: string;
            nextOffset: number | null;
        };
        restored += data.text;
        if (data.nextOffset === null)
            break;
        offset = data.nextOffset;
    }
    expect(JSON.parse(restored)).toEqual([{ event: source, index: 0 }]);
});
// Separate homes may contain the same conversation ID after a restore. Their
// workers must remain independent, and shutdown must abort/drain leased work.
it("scopes queues to their store and drains active summaries safely on shutdown", async () => {
    const homes = await Promise.all([mkdtemp(path.join(tmpdir(), "ponder-queue-a-")), mkdtemp(path.join(tmpdir(), "ponder-queue-b-"))]);
    const stores = homes.map(home => new SqliteStore(home));
    try {
        const session = await createSessionStore({ store: stores[0]!, defaultSessionCwd: () => homes[0]!, appendRuntimeEvent: async () => { } }).createSession({ provider: "openai", systemKind: "openpond.ponder", hiddenFromDefaultSidebar: true });
        await stores[1]!.insertSessionAtFront(session);
        for (const store of stores) {
            const state = await store.readPonderHistory(session.id);
            state.originals = [{ index: 0, hash: "fixture", message: { role: "user", content: "Same conversation ID, separate home" } }];
            state.pending = ["0+1"];
            await store.savePonderHistory(session.id, state.revision, state);
        }
        const first = createPonderHistoryRuntime(stores[0] as TurnRepository);
        const second = createPonderHistoryRuntime(stores[1] as TurnRepository);
        let started = false;
        const work = first.recover(session.id, async (_source, _address, signal) => new Promise<string>((_resolve, reject) => { started = true; signal.addEventListener("abort", () => reject(new Error("shutdown interrupted")), { once: true }); }));
        const observed = expect(work).rejects.toThrow("shutdown interrupted");
        await second.recover(session.id, async () => "Independent other-home summary");
        expect((await stores[1]!.readPonderHistory(session.id)).summaries["0+1"]).toBe("Independent other-home summary");
        expect(started).toBe(true);
        await first.close();
        await observed;
        expect((await stores[0]!.readPonderHistory(session.id)).pending).toEqual(["0+1"]);
        expect((await stores[0]!.readPonderHistory(session.id)).leases).toEqual({});
        await second.close();
    }
    finally {
        await Promise.all(stores.map(store => store.close()));
        await Promise.all(homes.map(home => rm(home, { recursive: true, force: true })));
    }
});

// A provider can emit plausible text and then report its output cap. Committing
// that fragment would silently lose decisions; preserve the job and fail usage.
it("rejects truncated semantic summaries and recovers their durable work after restart",async()=>{
    const {createHostedCompactionRuntime}=await import("../runtime/hosted-turn/compaction-runtime.js");
    const {TurnSchema}=await import("@openpond/contracts");
    const home=await mkdtemp(path.join(tmpdir(),"ponder-truncated-summary-"));let store=new SqliteStore(home);
    let runtime:ReturnType<typeof createHostedCompactionRuntime>|undefined;
    try{
        const session=await createSessionStore({store,defaultSessionCwd:()=>home,appendRuntimeEvent:async()=>{}}).createSession({provider:"openai",systemKind:"openpond.ponder",hiddenFromDefaultSidebar:true});
        const timestamp=new Date().toISOString();
        const turn=TurnSchema.parse({id:"truncate-owner",sessionId:session.id,providerTurnId:null,prompt:"Continue",startedAt:timestamp,completedAt:timestamp,status:"completed",error:null});await store.insertTurn(turn);
        const events=[{id:"original",sessionId:session.id,turnId:"prior",timestamp,name:"turn.started",source:"server",args:{prompt:"Exact decision ".repeat(1800)}}] as import("@openpond/contracts").RuntimeEvent[];
        const makeRuntime=(truncated:boolean)=>createHostedCompactionRuntime({ponderHistoryStore:store as TurnRepository,sessionForPonderHistory:async()=>session,loadAppPreferences:async()=>{throw new Error("not used");},appendRuntimeEvent:async()=>{},runtimeEventsForSession:async()=>events,upsertModelUsageRecord:async record=>{await store.upsertModelUsageRecord(record);},throwIfInterrupted:signal=>signal.throwIfAborted(),interruptedError:()=>new Error("interrupted"),streamPonderHistorySummary:async function*(){yield {text:truncated?"Plausible but incomplete summary":"Complete retained semantic decision"};yield {finishReason:truncated?"length":"stop"};}});
        runtime=makeRuntime(true);
        await runtime.prepareHostedProviderRequest({session,turn,provider:"openai",model:"configured-model",maxContextTokens:500000,maxOutputTokens:1000,messages:[{role:"user",content:events[0]!.args!.prompt as string},{role:"user",content:"Continue"}],prompt:"Continue",systemPrompt:"",signal:new AbortController().signal,roundIndex:0});
        for(let attempt=0;attempt<100&&!Object.keys((await store.readPonderHistory(session.id)).failures??{}).length;attempt++)await new Promise(resolve=>setTimeout(resolve,10));
        const failed=await store.readPonderHistory(session.id);
        expect(failed.pending).toEqual(["0+1"]);expect(failed.summaries).toEqual({});expect(failed.failures?.["0+1"]?.error).toBe("ponder_history_summary_truncated");
        expect((await store.listModelUsageRecords({sessionId:session.id,visibility:"all"})).some(record=>record.status==="failed")).toBe(true);
        await runtime.closePonderHistory();runtime=undefined;await store.close();store=new SqliteStore(home);runtime=makeRuntime(false);
        for(let attempt=0;attempt<100&&(await store.readPonderHistory(session.id)).pending.length;attempt++)await new Promise(resolve=>setTimeout(resolve,10));
        const recovered=await store.readPonderHistory(session.id);expect(recovered.pending).toEqual([]);expect(recovered.summaries["0+1"]).toBe("Complete retained semantic decision");
        const attempts=await store.listModelUsageRecords({sessionId:session.id,visibility:"all"});
        expect(attempts.some(record=>record.status==="failed")).toBe(true);expect(attempts.some(record=>record.status==="completed")).toBe(true);
        expect(new Set(attempts.map(record=>record.requestId)).size).toBe(attempts.length);
    }finally{await runtime?.closePonderHistory();await store.close();await rm(home,{recursive:true,force:true});}
});

// Older Messages providers require a retained conversation to start with user.
// A byte cutoff between an old user/assistant pair must summarize the whole turn.
it("keeps the retained historical suffix at a user boundary under smaller model budgets",async()=>{
    const home=await mkdtemp(path.join(tmpdir(),"ponder-history-turn-boundary-"));const store=new SqliteStore(home);
    try{
        const session=await createSessionStore({store,defaultSessionCwd:()=>home,appendRuntimeEvent:async()=>{}}).createSession({provider:"openai",systemKind:"openpond.ponder",hiddenFromDefaultSidebar:true});
        const historical:HostedChatMessage[]=[{role:"user",content:"Prior exact assignment ".repeat(1400)},{role:"assistant",content:"Small prior response"}];
        const current={role:"user" as const,content:"Current assignment"};
        const runtime=createPonderHistoryRuntime(store as TurnRepository);
        const admitted=await runtime.prepare({sessionId:session.id,requestId:"turn-boundary",initialPrompt:current.content,historical,messages:[...historical,current],fits:messages=>JSON.stringify(messages).length<3000,summarize:async(_source,address)=>`Complete semantic range ${address}`});
        expect(admitted.find(message=>message.role!=="system")?.role).toBe("user");
        expect(admitted.at(-1)).toEqual(current);expect((await store.readPonderHistory(session.id)).views.overview.entryCount).toBe(2);
        await runtime.close();
    }finally{await store.close();await rm(home,{recursive:true,force:true});}
});
