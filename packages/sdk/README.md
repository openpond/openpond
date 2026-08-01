# `@openpond/sdk`

The OpenPond SDK is the server-side TypeScript client for running agentic work in OpenPond sandboxes. It gives Node.js applications, Next.js route handlers, workers, and backend services a small API for creating sandboxes, executing commands, managing files and runtimes, and running a model/tool loop in a persistent workspace.

OpenPond is an open-source agent orchestration system for doing durable work with any model, provider, or subscription. The desktop app, CLI/TUI, and this SDK live in the same repository and share the sandbox client implementation. Desktop builds use the workspace source directly; installing this package from npm is only for external applications.

## Install

```bash
npm install @openpond/sdk
```

Node.js 22.14 or newer is required. This package is server-only: never expose an OpenPond API key in browser code or a `NEXT_PUBLIC_*` environment variable.

## Next.js route handler

```ts
// app/api/work/route.ts
import { createOpenPondClient } from "@openpond/sdk";

export const runtime = "nodejs";
export const maxDuration = 800;

const openpond = createOpenPondClient({
  apiKey: process.env.OPENPOND_API_KEY!,
  baseUrl: process.env.OPENPOND_API_URL,
});

export async function POST(request: Request) {
  const { prompt, sandboxId } = await request.json();
  const result = await openpond.work.run({ prompt, sandboxId });
  return Response.json(result);
}
```

`work.run` creates a sandbox when `sandboxId` is omitted. Pass the returned ID into the next turn to continue in the same filesystem. Use `onEvent` to stream sandbox, model, and command progress to a client.

Work requires a real `remote-firecracker` runtime. It fails closed if an environment returns the simulator or a nominal remote sandbox responds with a non-executing command marker, so an accepted command can never be mistaken for actual filesystem work.

## Raw sandbox API

```ts
import { createOpenPondClient } from "@openpond/sdk";

const openpond = createOpenPondClient({
  apiKey: process.env.OPENPOND_API_KEY!,
});

const sandbox = await openpond.sandboxes.create(
  {
    repo: "https://github.com/octocat/Hello-World",
    budget: { maxUsd: "0.25" },
  },
  { async: true },
);

const result = await openpond.sandboxes.exec(sandbox.id, {
  command: "git status --short",
  timeoutSeconds: 60,
});

console.log(result.command.output);
```

The package also exports `createOpenPondSandboxClient`, all public sandbox input and response types, and the OpChat helpers used by the Work loop.

## Staging

Use a server-only environment file while developing:

```dotenv
OPENPOND_API_KEY=opk_...
OPENPOND_API_URL=https://staging-api.openpond.ai
```

If the staging deployment has Vercel protection enabled, also set `VERCEL_AUTOMATION_BYPASS_SECRET`. The SDK only sends that bypass header to OpenPond staging hosts.

## Lifecycle and cleanup

Work sandboxes remain available so conversations can continue. Delete them when a conversation is removed or expires:

```ts
await openpond.work.deleteSandbox(sandboxId);
```

Use conservative budgets and application-level retention. API keys, provider credentials, and bypass secrets must remain in server-side configuration.

## Development

From the OpenPond monorepo:

```bash
pnpm sdk:check
```

The package has an independent version and release workflow. Updating `@openpond/sdk` does not change the desktop, CLI, or TUI version.

## Maintainer release setup

The first release requires a one-time npm bootstrap because npm trusted publishing can only be configured after the package exists. After the feature PR is merged, run these commands from a clean, current `master` checkout:

```bash
pnpm sdk:check
npm login
npm publish ./packages/sdk --access public --ignore-scripts
npm install --global npm@^11.15.0
npm trust github @openpond/sdk \
  --repo openpond/openpond \
  --file release-sdk.yml \
  --environment npm-production \
  --allow-publish
npm trust list @openpond/sdk
gh workflow run release-sdk.yml --ref master
```

The GitHub `npm-production` environment already used by the OpenPond CLI can be reused. The trust record is package-specific, so `@openpond/sdk` still needs its own entry.

The final command dispatches the idempotent recovery path once: npm publication is already complete, so the workflow only creates the missing `sdk-v0.0.1` tag and GitHub release. It does not attempt to republish the immutable version.

After bootstrap, prepare releases independently:

```bash
pnpm release:sdk:patch
# or release:sdk:minor / release:sdk:major
```

That command creates an SDK-only release PR. Merging it triggers `release-sdk.yml`; desktop and CLI releases continue to use the existing `pnpm release:patch` command and workflow.
