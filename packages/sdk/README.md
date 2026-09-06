# `openpond-sdk`

See [task evidence and learning](./LEARNING.md) for reusable Rewards, task-format publication, SDK/HTTP intake, grading, review and approved batches.

The OpenPond SDK is the server-side TypeScript client for running agentic work in OpenPond sandboxes. It gives Node.js applications, Next.js route handlers, workers, and backend services a small API for creating sandboxes, executing commands, managing files and runtimes, and running a model/tool loop in an isolated workspace.

OpenPond is an open-source agent orchestration system for doing durable work with any model, provider, or subscription. The desktop app, CLI/TUI, and this SDK live in the same repository and share the sandbox client implementation. Desktop builds use the workspace source directly; installing this package from npm is only for external applications.

## Install

```bash
npm install openpond-sdk
```

Node.js 22.14 or newer is required. This package is server-only: never expose an OpenPond API key in browser code or a `NEXT_PUBLIC_*` environment variable.

## Next.js route handler

```ts
// app/api/work/route.ts
import { createOpenPondClient } from "openpond-sdk";

export const runtime = "nodejs";
export const maxDuration = 800;

const openpond = createOpenPondClient({
  apiKey: process.env.OPENPOND_API_KEY!,
  baseUrl: process.env.OPENPOND_API_URL,
});

export async function POST(request: Request) {
  const { prompt } = await request.json();
  const result = await openpond.work.run({
    prompt,
    cleanup: "delete",
    persistOutput: async ({ output, download }) => {
      const response = await download();
      const bytes = Buffer.from(response.file.contentsBase64, "base64");
      await durableOutputStore.put({ output, bytes });
    },
  });
  return Response.json(result);
}
```

`work.run` creates a sandbox when `sandboxId` is omitted. Use `onEvent` to stream sandbox, model, command, persistence, and cleanup progress to a client. Keep API keys and the persistence callback in server code.

Completed files written under `/workspace/outputs` are collected automatically. The model does not need to publish or register them. Each detected file is emitted as an `output` event and returned in `result.outputs`:

```ts
const result = await openpond.work.run({
  prompt: "Create a DOCX summary",
  onEvent(event) {
    if (event.type === "output") console.log(event.output.name);
  },
});

for (const output of result.outputs) {
  const downloaded = await openpond.work.downloadOutput(
    result.sandboxId,
    output,
  );
  const bytes = Buffer.from(downloaded.file.contentsBase64, "base64");
  // Stream bytes from your authenticated server route.
}
```

Output descriptors include the sandbox path, filename, MIME type, size, modification time, and preview hints. `downloadOutput` remains available when the sandbox is kept. For ephemeral Work, use the lazy `download` function inside `persistOutput`; it verifies that the complete file arrived before deletion can begin.

If sandbox execution is unavailable, the API fails with the stable `sandbox_runner_unavailable` error instead of returning a successful command result.

API failures are exposed as `OpenPondApiError`, with `status` and stable `code` fields for server-side handling. `work.run` propagates these failures instead of asking the model to interpret infrastructure errors.

## Raw sandbox API

```ts
import { createOpenPondClient } from "openpond-sdk";

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

## Workflows and scheduled Work

Use `openpond.workflows` for model-driven scheduled Work. Workflows use the same Saved Work definitions, conversations, runs, and scheduler as the hosted OpenPond Workflows UI:

```ts
const workflow = await openpond.workflows.create({
  name: "Morning market brief",
  prompt: "Summarize the overnight market and write the brief to outputs.",
  recurrence: {
    version: 1,
    kind: "weekdays",
    timeZone: "America/New_York",
    startDate: "2026-08-18",
    localTime: "08:30",
    end: { kind: "never" },
  },
});

const catalog = await openpond.workflows.list();
await openpond.workflows.runNow(workflow.scheduleId);
await openpond.workflows.update(workflow.scheduleId, { enabled: false });
```

An external product can also let OpenPond own recurrence while keeping the
work itself inside that product. External callbacks are created disabled by
default by the caller, carry only an opaque external reference, and receive a
verifiable Saved Work run identity when OpenPond fires them:

```ts
await openpond.workflows.create({
  name: "Daily account review",
  prompt: "Run the account-owned daily review.",
  recurrence,
  enabled: false,
  target: {
    kind: "external_callback",
    callbackUrl: "https://app.example.com/api/workflows/openpond-callback",
    externalReference: "opaque_binding_id",
  },
});
```

`openpond.workflows` is distinct from `openpond.sandboxes.createSchedule()`. Workflows schedule model-driven Work and create normal Work conversations and run history. Raw sandbox schedules execute a declared sandbox command or action.

## Project Actions

Project Actions expose typed business functions from a normal Git Project to local OpenPond Work. The website and action wrapper can import the same neutral domain module, so the harness does not duplicate application logic.

```ts
// openpond/actions/analytics.ts
import { defineAction } from "openpond-sdk/actions";
import { z } from "zod";

import { getAnalyticsSummary } from "../../packages/domain/analytics.js";

export const getAnalytics = defineAction("analytics.get_summary", {
  description: "Get the current operating summary.",
  input: z.object({ businessId: z.string() }),
  output: z.object({ activeMoves: z.number(), bookedRevenueUsd: z.number() }),
  run(context, input) {
    context.trace("analytics.loaded", { businessId: input.businessId });
    return getAnalyticsSummary(input.businessId);
  },
});
```

The local-only runner does not require an OpenPond API key:

```ts
import { createLocalActionRunner } from "openpond-sdk/actions/local";

const runner = createLocalActionRunner({ projectRoot: process.cwd() });
const result = await runner.run({
  actionId: "analytics.get_summary",
  input: { businessId: "relocation" },
});
```

The default source directory is `openpond/actions`; generated files live in `.openpond/actions`. Override either path and map explicit runtime setup with `openpond/project-actions.json`:

```json
{
  "sourceDirectory": "src/actions",
  "outputDirectory": ".openpond/project-actions",
  "environment": {
    "apiToken": "CUSTOMER_API_TOKEN"
  },
  "connections": {
    "analytics-db": {
      "values": { "provider": "postgres" },
      "environment": { "url": "CUSTOMER_DATABASE_URL" }
    }
  }
}
```

Only declared values are forwarded into the child process. Use `context.env(name)` and `context.connection(name)` inside an action. Output files must be written inside `context.outputDirectory` and registered with `context.output(...)`.

## Lifecycle, persistence, and cleanup

The generic SDK defaults to `cleanup: "keep"` for backwards compatibility. Applications can choose one of three explicit terminal policies:

- `keep` leaves the sandbox running and makes the caller responsible for cleanup.
- `stop` releases active compute while retaining the sandbox for deliberate resume.
- `delete` removes ephemeral compute after output persistence succeeds.

Deleting a turn that produced outputs requires an awaited `persistOutput` callback. If an application intentionally does not need the files, it must say so with `discardOutputs: true`. A persistence failure stops the sandbox instead of deleting recoverable output state. `result.lifecycle` and `persistence`/`cleanup` events expose the ordering and final observed state.

For a follow-up turn on fresh compute, stage selected durable outputs as structured inputs:

```ts
await openpond.work.run({
  prompt: "Revise the report",
  cleanup: "delete",
  inputs: [{
    id: savedOutput.id,
    name: savedOutput.name,
    contentsBase64: savedOutput.contentsBase64,
    mimeType: savedOutput.mimeType,
    checksumSha256: savedOutput.sha256,
    revision: savedOutput.revision,
  }],
  persistOutput: saveOutput,
});
```

Inputs are placed under `/workspace/inputs/previous-outputs/` with a structured manifest at `/workspace/inputs/.openpond-context.json`. Arbitrary scratch files are not retained by ephemeral Work.

You can still delete a caller-managed sandbox directly:

```ts
await openpond.work.deleteSandbox(sandboxId);
```

The sandbox's 15-minute idle timeout is crash protection, not the normal successful-turn cleanup path. Use conservative budgets and application-level retention. API keys, provider credentials, and bypass secrets must remain in server-side configuration.

## Model Projects and training

The SDK exposes dependency-light contracts and API clients without importing
the OpenPond application server:

```ts
import {
  ModelProjectSchema,
  createModelProjectsClient,
} from "openpond-sdk/model-projects";
import {
  TrainingJobSubmissionSchema,
  createTrainingClient,
} from "openpond-sdk/training";
```

A Model Project is the mutable authoring object and owns one current training
setup. Tasksets, Harnesses, evidence, Jobs, and Model Versions remain separate
resources connected by immutable references. Submitting training snapshots the
exact Project revision into an immutable Job; the Job is the durable Run
identity and explicit approval is captured for that submission only.

`createModelProjectsClient` synchronizes and reads hosted Project projections.
`createTrainingClient` reads capabilities and creates or observes immutable
Jobs, including Project-filtered Run history. These clients require an
authenticated server-side API context; the schemas themselves contain no
database, provider, credential, Electron, or UI dependencies. See
[TRAINING_PROTOCOL.md](./TRAINING_PROTOCOL.md) for media types, hashing, size
limits, compatibility rules, provider routes, receipts, and the published
conformance fixtures.

## Development

From the OpenPond monorepo:

```bash
pnpm sdk:check
```

The package has an independent version and release workflow. Updating `openpond-sdk` does not change the desktop, CLI, or TUI version.

## Maintainer release setup

The first release requires a one-time npm bootstrap because npm trusted publishing can only be configured after the package exists. After the feature PR is merged, run these commands from a clean, current `master` checkout:

```bash
pnpm sdk:check
npm login
npm publish ./packages/sdk --access public --ignore-scripts --provenance=false
npm install --global npm@^11.15.0
npm trust github openpond-sdk \
  --repo openpond/openpond \
  --file release-sdk.yml \
  --environment npm-production \
  --allow-publish
npm trust list openpond-sdk
gh workflow run release-sdk.yml --ref master
```

The GitHub `npm-production` environment already used by the OpenPond CLI can be reused. The trust record is package-specific, so `openpond-sdk` still needs its own entry.

The final command dispatches the idempotent recovery path once: npm publication is already complete, so the workflow only creates the missing `sdk-v0.0.1` tag and GitHub release. It does not attempt to republish the immutable version.

After bootstrap, prepare releases independently:

```bash
pnpm release:sdk:patch
# or release:sdk:minor / release:sdk:major
```

That command creates an SDK-only release PR. Merging it triggers `release-sdk.yml`; desktop and CLI releases continue to use the existing `pnpm release:patch` command and workflow.
