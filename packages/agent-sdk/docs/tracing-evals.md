# Tracing And Evals

The local runtime harness records structured events and artifacts into trace JSONL.

## Trace Helpers

```ts
await ctx.step("load-context", async () => loadContext());
await ctx.model("draft-answer", async () => "answer");
await ctx.tool("lookup", async () => ({ ok: true }));
await ctx.action("post-process", async () => ({ ok: true }));
await ctx.loadSkill("reply-style");
ctx.trace.event("custom.event", { count: 1 });
ctx.trace.artifact("artifacts/result.json");
```

Secret-like keys are redacted before trace output. Trace JSONL entries use `openpond.agent.trace.v1`.

## Eval Helpers

```ts
await t.send({ prompt: "hello", channel: "openpond_chat" });
await t.runAction("chat", { prompt: "hello", channel: "api" });
t.expectIntent("answer");
t.expectTextIncludes("hello");
t.expectArtifact("artifacts/result.json");
t.expectTraceEvent("model.completed");
```

Eval results include source metadata, fixture hashes, assertion summaries, trace refs, artifact refs, and publish-gate rollups. `expectedArtifacts` can declare static artifact expectations for validation before an eval runs.

The SDK stores detailed traces and evals as artifacts. UI and conversation timelines should use compact projections that link to these artifacts.
