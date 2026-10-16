import { createBackgroundWorkerQueue } from "../../runtime/background-worker-queue.js";
import { createHash, randomUUID } from "node:crypto";
import type { HostedChatMessage } from "@openpond/cloud";
import type { TurnRepository } from "../../runtime/turns/ports.js";
import { ponderOriginalHash, type PonderHistoryState } from "../../store/store-ponder-history.js";
import { advanceMemoryView, renderMemoryView } from "./view.js";
type SummaryExecutor = (source: string, address: string, signal: AbortSignal) => Promise<string>;
const workers = new WeakMap<TurnRepository, {
    queue: ReturnType<typeof createBackgroundWorkerQueue>;
    queued: Map<string, Promise<void>>;
    timers: Map<string, ReturnType<typeof setTimeout>>;
    controller: AbortController;
    closing: boolean;
}>();
export function createPonderHistoryRuntime(store: TurnRepository) {
    let worker = workers.get(store);
    if (!worker) {
        worker = { queue: createBackgroundWorkerQueue({ queueId: "ponder-history-summary", concurrency: 2, keyForJob: metadata => String(metadata.sessionId) }), queued: new Map(), timers: new Map(), controller: new AbortController(), closing: false };
        workers.set(store, worker);
    }
    const owned = worker;
    const summaryQueue = owned.queue;
    const queued = owned.queued;
    async function close() { owned.closing = true; owned.controller.abort(); for (const timer of owned.timers.values())
        clearTimeout(timer); owned.timers.clear(); await summaryQueue.drain(); }
    async function update(sessionId: string, mutate: (state: PonderHistoryState) => void) {
        if (!store.readPonderHistory || !store.savePonderHistory)
            throw new Error("ponder_history_storage_unavailable");
        for (let attempt = 0; attempt < 16; attempt++) {
            const state = await store.readPonderHistory(sessionId);
            mutate(state);
            if (await store.savePonderHistory(sessionId, state.revision, state))
                return state;
        }
        throw new Error("ponder_history_concurrent_update");
    }
    function recover(sessionId: string, summarize: SummaryExecutor): Promise<void> {
        if (owned.closing)
            return Promise.reject(new Error("ponder_history_closed"));
        const retryTimer = owned.timers.get(sessionId);
        if (retryTimer) {
            clearTimeout(retryTimer);
            owned.timers.delete(sessionId);
        }
        const existing = queued.get(sessionId);
        if (existing)
            return existing;
        const receipt = summaryQueue.enqueue({ label: "Ponder semantic history summaries", metadata: { sessionId } }, async () => {
            if (!store.readPonderHistory)
                throw new Error("ponder_history_storage_unavailable");
            let state = await store.readPonderHistory(sessionId);
            for (;;) {
                owned.controller.signal.throwIfAborted();
                state = await store.readPonderHistory(sessionId);
                const key = state.pending.slice().sort((a, b) => Number(a.split("+")[1]) - Number(b.split("+")[1]))[0];
                if (!key)
                    break;
                const [start = 0, count = 0] = key.split("+").map(Number);
                const held = state.leases?.[key];
                if (held && held.expiresAt > Date.now())
                    await new Promise<void>(resolve => { const done = () => { clearTimeout(timer); owned.controller.signal.removeEventListener("abort", done); resolve(); }; const timer = setTimeout(done, Math.min(120000, held.expiresAt - Date.now() + 10)); owned.controller.signal.addEventListener("abort", done, { once: true }); });
                owned.controller.signal.throwIfAborted();
                const owner = randomUUID();
                let claimed = false;
                state = await update(sessionId, state => {
                    claimed = false;
                    if (!state.pending.includes(key) || state.summaries[key])
                        return;
                    state.leases ??= {};
                    const lease = state.leases[key];
                    if (lease && lease.expiresAt > Date.now())
                        throw new Error("ponder_history_summary_busy");
                    state.leases[key] = { owner, expiresAt: Date.now() + 120000 };
                    claimed = true;
                });
                if (!claimed)
                    continue;
                const heartbeat = setInterval(() => {
                    void update(sessionId, state => {
                        if (state.leases?.[key]?.owner === owner)
                            state.leases[key]!.expiresAt = Date.now() + 120000;
                    }).catch(() => { });
                }, 30000);
                heartbeat.unref();
                try {
                    const left = state.summaries[`${start}+${count / 2}`];
                    const right = state.summaries[`${start + count / 2}+${count / 2}`];
                    const range = state.originals.slice(start, start + count);
                    const turns = new Set(range.map(original => original.turnId).filter(Boolean));
                    const source = count > 1 && left && right ? JSON.stringify({ left, right }) : JSON.stringify({ dialogue: range.map(original => original.message), events: state.sourceEvents?.filter(event => event.turnId && turns.has(event.turnId) && event.name !== "assistant.delta" && event.name !== "turn.started") ?? [] });
                    async function bounded(source: string, path: string): Promise<string> {
                        if (Buffer.byteLength(source) <= 24000)
                            return summarize(source, path, owned.controller.signal);
                        const chunks: string[] = [];
                        for (let offset = 0; offset < source.length;) {
                            let end = Math.min(source.length, offset + 12000);
                            while (Buffer.byteLength(source.slice(offset, end)) > 24000)
                                end = offset + Math.floor((end - offset) / 2);
                            chunks.push(await summarize(source.slice(offset, end), `${path}:part-${chunks.length}`, owned.controller.signal));
                            offset = end;
                        }
                        const reduced = JSON.stringify(chunks);
                        if (Buffer.byteLength(reduced) >= Buffer.byteLength(source))
                            throw new Error("ponder_history_summary_did_not_reduce");
                        return bounded(reduced, `${path}:merge`);
                    }
                    const text = (await bounded(source, key)).trim();
                    if (!text)
                        throw new Error("ponder_history_summary_empty");
                    state = await update(sessionId, state => {
                        if (state.leases?.[key]?.owner !== owner)
                            throw new Error("ponder_history_summary_lease_lost");
                        state.summaries[key] ??= text;
                        state.summarySourceHashes ??= {};
                        state.summarySourceHashes[key] = createHash("sha256").update(source).digest("hex");
                        state.pending = state.pending.filter(pending => pending !== key);
                        delete state.leases[key];
                        if (state.failures)
                            delete state.failures[key];
                    });
                }
                catch (error) {
                    await update(sessionId, state => {
                        if (state.leases?.[key]?.owner === owner)
                            delete state.leases[key];
                        state.failures ??= {};
                        const attempts = (state.failures[key]?.attempts ?? 0) + 1;
                        state.failures[key] = { attempts, error: error instanceof Error ? error.message : String(error), retryAt: Date.now() + Math.min(60000, 5000 * 2 ** (attempts - 1)) };
                    });
                    throw error;
                }
                finally {
                    clearInterval(heartbeat);
                }
            }
        });
        const done = receipt.done.then(result => {
            if (result.status === "failed")
                throw new Error(result.error ?? "ponder_history_summary_failed");
        }).finally(() => queued.delete(sessionId));
        queued.set(sessionId, done);
        void done.catch(async () => {
            const state = await store.readPonderHistory?.(sessionId);
            const failure = state?.pending.map(key => state.failures?.[key]).find(Boolean);
            if (owned.closing || !failure || failure.attempts >= 3 || failure.error.includes("credential_changed"))
                return;
            const timer = setTimeout(() => { owned.timers.delete(sessionId); void recover(sessionId, summarize).catch(() => { }); }, Math.max(0, failure.retryAt - Date.now()));
            owned.timers.set(sessionId, timer);
            timer.unref();
        }).catch(() => { });
        return done;
    }
    async function prepare(input: {
        sessionId: string;
        requestId: string;
        turnId?: string;
        initialPrompt?: string;
        metadata?: Record<string, unknown>;
        sourceEvents?: import("@openpond/contracts").RuntimeEvent[];
        messages: HostedChatMessage[];
        historical: HostedChatMessage[];
        historicalTurnIds?: Array<string | null>;
        fits: (messages: HostedChatMessage[]) => boolean;
        summarize: SummaryExecutor;
    }) {
        const admitted = await store.getPonderHistoryRequest?.(input.requestId, input.sessionId);
        if (admitted)
            return admitted.messages;
        // Only past dialogue becomes semantic history. Active request/tool state is
        // preserved as an indivisible suffix, including provider continuation data.
        const previous = input.turnId ? await store.latestPonderHistoryRequest?.(input.turnId, input.sessionId) : null;
        let activeStart = typeof previous?.metadata.activeStart === "number" ? previous.metadata.activeStart : -1;
        if (activeStart < 0 && input.initialPrompt)
            for (let index = input.messages.length - 1; index >= 0; index--)
                if (input.messages[index]!.role === "user" && input.messages[index]!.content === input.initialPrompt) {
                    activeStart = index;
                    break;
                }
        if (activeStart < 0)
            for (let index = input.messages.length - 1; index >= 0; index--)
                if (input.messages[index]!.role === "user") {
                    activeStart = index;
                    break;
                }
        activeStart = Math.max(0, activeStart);
        const system = input.messages.slice(0, activeStart).filter(message => message.role === "system" && !(typeof message.content === "string" && (message.content.startsWith("<ponder-history-overview>") || message.content.includes("Conversation summary from earlier turns:"))));
        const historical = input.historical;
        const active = input.messages.slice(activeStart);
        let state = await update(input.sessionId, state => {
            if (input.sourceEvents)
                state.sourceEvents = input.sourceEvents;
            for (let index = 0; index < historical.length; index++) {
                const message = historical[index]!;
                const hash = ponderOriginalHash(message);
                if (state.originals[index]?.hash === hash)
                    continue;
                if (state.originals[index])
                    throw new Error("ponder_history_original_changed");
                state.originals.push({ index, hash, message, turnId: input.historicalTurnIds?.[index] });
            }
        });
        // Durable jobs remain pending until their model response has committed. A
        // restart retries the job; summaries never replace canonical originals.
        let archivalBoundary = state.originals.length;
        let recentBytes = 0;
        while (archivalBoundary > 0) {
            const bytes = Buffer.byteLength(JSON.stringify(state.originals[archivalBoundary - 1]!.message));
            if (recentBytes + bytes > 24000)
                break;
            recentBytes += bytes;
            archivalBoundary--;
        }
        while (archivalBoundary < state.originals.length && !input.fits([...system, ...state.originals.slice(archivalBoundary).map(original => original.message), ...active]))
            archivalBoundary++;
        // A provider-neutral retained suffix begins at a whole historical user
        // turn, never an assistant prefill or an orphan tool-result message.
        while(archivalBoundary<state.originals.length&&state.originals[archivalBoundary]!.message.role!=="user")archivalBoundary++;
        const addresses: Array<{
            startIndex: number;
            entryCount: number;
        }> = [];
        for (let count = 1; count <= archivalBoundary; count *= 2)
            for (let start = 0; start + count <= archivalBoundary; start += count)
                addresses.push({ startIndex: start, entryCount: count });
        state = await update(input.sessionId, state => {
            state.summaryConfiguration = input.metadata;
            for (const part of addresses) {
                const key = `${part.startIndex}+${part.entryCount}`;
                if (!state.summaries[key] && !state.pending.includes(key))
                    state.pending.push(key);
            }
        });
        const completion = recover(input.sessionId, input.summarize);
        // Background failures remain durable pending work and are retried at startup
        // or admission. Await only if the admitted request needs those summaries.
        void completion.catch(() => { });
        let ceiling = 30000;
        let messages: HostedChatMessage[] = input.messages;
        let awaited = false;
        while (ceiling >= 256) {
            state = await update(input.sessionId, state => { state.views.overview = advanceMemoryView({ view: state.views.overview, total: archivalBoundary, ceiling, summaries: new Map(Object.entries(state.summaries)), forceBatch: ceiling < state.views.overview.ceiling }); });
            let covered = state.views.overview.entryCount;
            while(covered>0&&covered<state.originals.length&&state.originals[covered]!.message.role!=="user")covered--;
            messages = [...system, { role: "system", content: renderMemoryView(state.views.overview).content }, ...state.originals.slice(covered).map(original => original.message), ...active];
            if (input.fits(messages))
                break;
            if (!awaited) {
                await completion;
                awaited = true;
                state = await store.readPonderHistory!(input.sessionId);
                continue;
            }
            ceiling = Math.floor(ceiling / 2);
        }
        if (!input.fits(messages))
            throw new Error("ponder_history_active_request_exceeds_context");
        if (!store.admitPonderHistoryRequest)
            throw new Error("ponder_history_storage_unavailable");
        return store.admitPonderHistoryRequest(input.requestId, input.sessionId, messages, { ...input.metadata, activeStart: messages.length - active.length, boundary: state.originals.length, revision: state.revision, view: state.views.overview });
    }
    return { prepare, recover, close };
}
