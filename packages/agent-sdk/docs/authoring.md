# Authoring Guide

An OpenPond TypeScript agent project starts with `agent/agent.ts`.

```ts
import {
  action,
  defineAgentProject,
  defineIntent,
  defineIntentRouter,
} from "openpond-agent-sdk/primitives";

const answer = defineIntent({
  name: "answer",
  description: "Answer the user.",
  async run(_ctx, input) {
    return { text: input.prompt, intent: "answer" };
  },
});

const chat = defineIntentRouter({
  intents: [answer],
  defaultIntent: answer,
});

export default defineAgentProject({
  name: "my-agent",
  version: "0.1.0",
  useCase: "custom-agent",
  manifestMode: "typescript",
  runtime: { base: "node-bun-workspace" },
  defaultAction: "chat",
  actions: [action("chat", { target: { kind: "intent-router", router: chat } })],
});
```

## Recommended Source Layout

```text
agent/
  agent.ts
  instructions.md or instructions.ts
  actions/
  agents/
  remote-agents/
  workflows/
  tools/
  connections/
  channels/
  evals/
  schedules/
  editable.ts
src/
  implementation files
```

Keep source declarations deterministic. Do not read secrets, call provider APIs, create infrastructure, or depend on per-user state while evaluating `agent/agent.ts`.

## Actions

Actions are the only public runtime surface. Use `defineAction("chat", ...)` for the default natural-language provider/MCP ingress action and `defineAction("water.estimate", ...)` or similar IDs for direct calls. Agent-like user choices should still be actions, for example `defineAction("water-estimator.chat", { target: { kind: "local-agent", agent: "water-estimator" } })`.

Local agents, remote-agent references, workflows, tools, and MCP client connections stay behind actions. The inspect/build artifacts expose a flat `actionCatalog`; web, OpenPond App, Slack, Teams, MCP, evals, schedules, and direct HTTP calls should select from that catalog instead of exposing separate primary Agents/Tools/Workflows menus.

## Input Schemas

Use `inputSchema` for the runtime manifest form schema and `inputSchemas` for named action/tool schema references. These are JSON-schema-shaped objects, so file upload metadata such as `x-openpond-upload` can live in TypeScript source and compile into `.openpond/openpond-manifest.preview.yaml`.

## Channels

Default templates should expose a `chat` action. Channel adapters normalize provider-specific events into `AgentChatInput` and render `AgentChatResult` back into provider responses. File discovery alone does not activate a channel; platform setup still selects channels and binds integrations.

Channel declarations describe setup and response rendering. Do not encode Slack, Teams, or MCP business routing rules in channel metadata; natural-language provider traffic goes to `chat`, and explicit native UI selections pass a selected action ID.

## Editing Policy

Use `editable(...)` to describe Builder Chat/source edit behavior. The platform owns work items, source refs, credentials, commits, PRs, and publish. The SDK owns inspect, validate, build, eval, traces, and generated artifacts.
