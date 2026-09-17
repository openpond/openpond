# Embed full Work

`openpond/app-server` exports the same full app-server used by Work, with TypeScript declarations and the JSONL transport. It is distinct from the SDK's lightweight `work.run()` loop. Use a pinned `openpond` package version containing this entry point and the Node version required by that package.

The embedding application owns authentication, tenant authorization, product task records, conversations, inputs, artifacts and retention. App-server retains its existing SQLite and files for internal thread, event and Harness state. Keep `storeDir` on durable customer storage, outside disposable sandbox guests. One running app-server owns a home; do not run concurrent processes against the same home.

## Compose the runtime

```ts
import { createOpenPondAppServer, type OpenPondAppServerOptions } from "openpond/app-server";
import { z } from "zod";

const weekInput = z.object({ week: z.number().int().min(1) }).strict();

// Implement these adapters in the embedding application.
declare const modelStream: NonNullable<OpenPondAppServerOptions["streamOpenPondHostedChatTurn"]>;
declare const privateSandbox: NonNullable<OpenPondAppServerOptions["sandboxRequest"]>;
declare const authorizeTool: NonNullable<OpenPondAppServerOptions["embedding"]>["authorizeTool"];
declare function lookupAuthorizedWeek(input: {
  threadId: string; week: number; signal: AbortSignal;
}): Promise<Record<string, unknown>>;

const server = await createOpenPondAppServer({
  storeDir: "/var/lib/customer-work/runtime",
  workspaceDir: "/var/lib/customer-work/workspace",
  harness: {
    sourceDirectory: "/opt/customer-work/harness",
    workspaceId: "customer-work-v1",
    name: "Customer Work",
  },
  streamOpenPondHostedChatTurn: modelStream,
  sandboxRequest: privateSandbox,
  embedding: {
    allowedTools: ["lookup_week", "sandbox_exec", "sandbox_write_file", "resource_read"],
    authorizeTool,
    async resolveTools({ declarations }) {
      return declarations.filter(tool => tool.name === "lookup_week").map(() => ({
        name: "lookup_week",
        version: "1",
        inputSchema: weekInput,
        async execute({ session, args, signal }) {
          return lookupAuthorizedWeek({ threadId: session.id, week: args.week as number, signal });
        },
      }));
    },
  },
});

// Use server.runtime's thread/turn/event methods, or runAppServerJsonl({
//   appServer: server, readable: process.stdin, writable: process.stdout,
// }).
// Close during graceful shutdown after completing application persistence.
// await server.close();
```

The optional `harness` constructor setting installs and selects a trusted authored source directory containing `harness.json` and its declared assets. It uses the existing compiler, release store and immutable snapshots. Reopening the same home accepts identical source; changed source requires a new `workspaceId` and fails explicitly otherwise. Existing threads retain their admitted release. Keep the deployment source read-only and outside model control. Without this option, selection follows the existing Harness workflow.

Its `toolDeclarations` describe `lookup_week`, including description, side-effect class, timeout and input schema. Generate that schema with `z.toJSONSchema(weekInput, { target: "draft-7" })`; the existing Harness compiler records its content hash. Instructions and Skills continue to come from the admitted Harness. Credentials and executable bindings stay in application code, outside Harness content.

Start threads with `provider: "openpond"`, `experience: "work"` and the model ID understood by the injected model adapter. The provider ID selects this runtime path; the adapter determines the actual inference endpoint. Embedded mode rejects other provider paths and legacy create/improve runs, which do not use this tool admission boundary. For remote sandbox tools, attach the thread to the application's sandbox using `workspaceKind: "sandbox"` and `workspaceId`.

## Tool admission and authorization

- `allowedTools` is the deployment's explicit allowlist for both standard and custom tools. Standard tools retain their existing availability checks. Custom tools cannot replace a registered standard tool with the same name.
- `resolveTools` runs before inference using the admitted release and its declarations. Every declared tool must be permitted, have an implementation and match the declared schema hash. Missing, conflicting, undeclared and incompatible bindings fail the turn before inference.
- `authorizeTool` runs on every admitted invocation, including standard tools and resumed threads. Derive actor/tenant authority from application-owned thread mappings and current permissions. Prompt text, model arguments and arbitrary thread metadata are not proof of authorization. Authenticate and authorize thread reads, resume, subscriptions and downloads at the application boundary as well.
- Custom arguments are validated against the binding's Zod schema. Handlers receive the runtime thread/turn/call context and a signal combining turn cancellation with the declared timeout. The runtime stops waiting when aborted; handlers must honor the signal to stop their own I/O, subprocesses and side effects.
- Custom results must be JSON-serializable objects. The default limit is 64 KiB, adjustable with `maxToolOutputBytes`. Return references to persisted artifacts for larger outputs. Existing standard tools retain their own result handling.
- The runtime records binding names/versions on each turn and pins the custom binding set on the thread. A changed set or version requires a new thread. Existing Harness snapshots and overlays continue to identify the admitted release. Version handlers whenever their behavior changes.

Native tool dispatch is required in embedded mode; textual tool fallback cannot bypass the allowlist. Tool declarations describe capabilities, not deployment authority.

## Services and persistence

Supplying `embedding` requires an explicit model-stream adapter. Search, scheduling, connected-app discovery/execution, taskset tools, project actions, profile commands, automatic titles and background Harness review are disabled by default. No sandbox adapter means sandbox requests fail explicitly rather than using the hosted default.

`services` can supply `webSearch`, `scheduling`, `connectedApps` (both `list` and `execute`), `tasksets` and `projectActions` adapters. Set an option to `false` to disable it in the stock composition too. `profileActions: false` disables profile commands; they are always disabled when embedded. `backgroundReview` explicitly controls the built-in review/refiner service. Keep it off for deployments that must not perform automatic Harness improvement. A taskset tool adapter does not enable the separate Harness evaluation RPC workflow in embedded mode. Capability reporting reflects these controls and disabled RPC operations reject requests.

Omitting `embedding` preserves the stock runtime defaults. Service adapters alone do not install an authorization policy; embedded deployments should always supply `embedding`.

The constructor also exposes the existing lifecycle callbacks:

- `workInputsForSession(session)` supplies input descriptors (`localPath`, `storageName`, optional bytes/hash/size) to Work's existing tool context. The application controls which files the session can access and how they reach its sandbox.
- `finalizeWorkTurn({ session, turnId, outcome })` runs for completed, failed or interrupted Work turns. Persist outputs and await acknowledgement here, then perform application-owned guest cleanup and return the current session. A thrown persistence error fails the turn; the runtime does not retry the finalizer in that turn. Keep recoverable guest files on failure and make external persistence idempotent by turn/artifact ID.

Application task/conversation records remain the product source of truth. Map them to runtime thread/turn IDs and consume the existing event stream with replay/deduplication. Preserve the runtime home for restart; these hooks do not make app-server stateless.

## Deployment boundary

This API supplies runtime composition hooks. The deployment must still place app-server, its durable home and sandbox execution in the customer account, configure approved inference and private BYOC adapters, and enforce network/storage policy. It does not provision AWS resources or package a Python guest image. The BYOC adapter must reconcile sandbox action support and execution limits; longer Python jobs should use the sandbox process lifecycle through application bindings. Installing these hooks alone does not establish customer-account isolation.

After building the CLI package, run `pnpm exec tsx scripts/check-cli-distribution.ts --app-server-only`. This installs the actual npm tarball in a fresh consumer, typechecks this public API without workspace aliases and completes a Work turn through it. The full distribution check also includes this proof.
