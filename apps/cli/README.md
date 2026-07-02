# openpond

OpenPond CLI

Install:

```bash
npm i -g openpond
# or
npx --package openpond openpond tool list handle/repo
# or (curl installer)
curl -fsSL https://openpond.ai/install.sh | bash
```

Login (stores key in `~/.openpond/config.json`):

```bash
openpond login
# or (non-interactive)
openpond login --api-key opk_...
# or save under an account profile
openpond login --account production --api-key opk_prod_...
openpond login --account secondary --api-key opk_secondary_...
```

Commands:

```bash
openpond --version
openpond --check-update
openpond profiles list
openpond profiles use production
openpond profiles save secondary --api-key opk_...
openpond account
openpond health
openpond --account production apps list
openpond tool list <handle>/<repo>
openpond tool run <handle>/<repo> <tool> --body '{"foo":"bar"}'
openpond deploy watch <handle>/<repo> --branch main
openpond template status <handle>/<repo>
openpond template branches <handle>/<repo>
openpond template update <handle>/<repo> --env production
openpond repo create --name my-repo --path . [--sandbox]
openpond repo push --path . --branch main
openpond apps list [--handle <handle>] [--refresh] [--json]
openpond apps tools
openpond apps deploy <handle>/<repo> --env production --watch
openpond apps env get <handle>/<repo>
openpond apps env set <handle>/<repo> --env '{"OPENTOOL_PUBLIC_HL_SIGNAL_BOT_CONFIG":"..."}'
openpond apps performance [--app-id <id>]
openpond apps agent create --prompt "Build a daily digest agent"
openpond apps tools execute <appId> <deploymentId> <tool> --body '{"foo":"bar"}'
openpond apps positions tx --method GET --params '{"status":"open"}'
openpond opentool init --dir .
```

Global account selection:

- `--account <name>` (alias `--profile <name>`) selects which stored account/API key to use.
- `--base-url <url>` (alias `--baseurl`) selects the account entry matching that base URL when duplicate handles exist.
- `OPENPOND_ACCOUNT=<name>` sets the default selected account for a shell/session.
- If omitted, CLI uses the last active stored account.

Command reference:

- `openpond login`: prompt for API key and save to `~/.openpond/config.json`.
- `openpond login --api-key <key>`: save the API key without prompting.
- `openpond profiles list`: list redacted local profiles from `~/.openpond/config.json`.
- `openpond profiles use <name> [--base-url <url>]`: switch the active local profile.
- `openpond profiles save <name> --api-key <key> [--base-url <url>] [--environment <name>]`: save or update a local profile API key.
- `openpond account`: fetch current account/profile fields and active products for the selected API key.
- `openpond health`: check public API reachability and selected API-key auth health when a key is configured.
- `openpond tool list <handle>/<repo>`: list tools for the latest deployment.
- `openpond tool run <handle>/<repo> <tool> [--body <json>] [--method <METHOD>]`: run a tool on the latest deployment.
- `openpond deploy watch <handle>/<repo> [--branch <branch>]`: stream deployment logs for the latest deployment.
- `openpond template status <handle>/<repo>`: check whether a template update is available.
- `openpond template branches <handle>/<repo>`: list available template branches.
- `openpond template update <handle>/<repo> [--env preview|production]`: deploy the latest template commit.
- `openpond repo create --name <name> [--path <dir>] [--empty|--opentool] [--sandbox] [--deploy-on-push]`: create an OpenPond repo and attach the git remote.
- `openpond repo push [--path <dir>] [--branch <branch>]`: push the current git branch using a tokenized remote (non-interactive, restores origin after push).
- `openpond apps list [--handle <handle>] [--refresh] [--json]`: list apps for your account, optionally filtered by handle.
- `openpond apps tools`: list tools for your account (public API).
- `openpond apps deploy <handle>/<repo> [--env preview|production] [--watch]`: trigger a deployment for an app.
- `openpond apps env get <handle>/<repo>`: get OPENTOOL_PUBLIC_* env vars for an app.
- `openpond apps env set <handle>/<repo> --env <json>`: set OPENTOOL_PUBLIC_* env vars for an app.
- `openpond apps performance [--app-id <id>]`: fetch performance summary, optionally scoped to an app.
- `openpond apps agent create --prompt <text> [--template-id <id>]`: create an agent from a prompt (streams deploy logs by default).
- `openpond apps tools execute <appId> <deploymentId> <tool> [--body <json>] [--method <METHOD>] [--headers <json>]`: execute a tool for a specific deployment.
- `openpond apps positions tx [--method <GET|POST>] [--body <json>] [--params <json>]`: read or submit positions.
- `openpond opentool <init|validate|build> [args]`: run OpenTool CLI commands via `npx opentool`.

Agent source/edit status:

- `openpond agent edit check-status <workItemId> --team-id <id> [--limit <n>] [--json]`: return the compact source-check status for an agent edit work item.
- `openpond agent source check-status <workItemId> --team-id <id> [--limit <n>] [--json]`: alias for the same work-item status projection under the source command group.
- The machine-readable status contract is documented in [`docs/agent-edit-check-status-json.md`](docs/agent-edit-check-status-json.md).

## TypeScript package

Programmatic API that mirrors the CLI command surface:

```ts
import {
  createClient,
  listConfiguredProfiles,
  saveProfileApiKey,
  setActiveProfile,
} from "openpond";

const client = createClient({ apiKey: process.env.OPENPOND_API_KEY! });

const { tools } = await client.tool.list("handle/repo");
const result = await client.tool.run("handle/repo", "myTool", {
  body: { foo: "bar" },
});

const apps = await client.apps.list();
const account = await client.account.get();
const balance = await client.account.balance();
const health = await client.account.health();
const accountTools = await client.apps.tools();
const performance = await client.apps.performance({ appId: "app_123" });
const repo = await client.repo.create({ name: "my-repo", repoInit: "empty" });

const profiles = await listConfiguredProfiles();
await setActiveProfile("0xglu", { baseUrl: "https://openpond.ai" });
await saveProfileApiKey({
  handle: "secondary",
  apiKey: "opk_...",
  baseUrl: "https://openpond.ai",
});

await client.apps.agentCreate(
  { prompt: "Build a daily digest agent" },
  {
    onItems: (items) => {
      for (const item of items) {
        console.log(item);
      }
    },
  }
);
```

You can override hosts with `apiUrl` and `toolUrl` in `createClient`, or
via `OPENPOND_API_URL` and `OPENPOND_TOOL_URL`.

Examples live in `examples`.


## Run

```bash
bun install
bun run dev
```

Cache:

- `~/.openpond/cache.json` caches app/tool lists for 1 hour and refreshes automatically on next use.
