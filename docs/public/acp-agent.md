# Use OpenPond from an ACP application

`openpond acp` exposes OpenPond's own harness over ACP v1 and newline-delimited JSON on standard input/output. An ACP application launches it as a local process. It runs the existing OpenPond Work runtime, model route, tools and durable conversation store.

This command is available in source builds containing the ACP agent change. Registry publication is deferred; an existing npm release must not be assumed to include the command. Check `openpond acp --help` before configuring an installed executable.

## Set up the agent

Use Node.js 24.18 or newer in the Node 24 release line. Choose a dedicated home for this agent and sign in through the existing OpenPond login flow:

```bash
openpond acp --home /absolute/path/to/openpond-acp-home --login
```

Login prompts for an OpenPond API key, stores it in OpenPond's encrypted credential store, verifies that the account can access its model catalog, and exits. A configured credential alone does not establish inference entitlement or available balance; a prompt can still report a model route error. Optional `--account HANDLE` and `--base-url URL` select the account using the CLI's existing configuration rules. Credentials belong to OpenPond, independently of the editor's own model settings.

Configure the application to launch:

```text
command: /absolute/path/to/openpond
args: ["acp", "--home", "/absolute/path/to/openpond-acp-home"]
```

For a source build, the command can instead be the absolute Node executable, with the absolute `apps/cli/dist/cli.js` path prepended to those arguments. Build dependencies with `pnpm run build:sdk`, compile the server with `node scripts/run-typescript.mjs tsc -b apps/server`, and bundle with `pnpm --dir apps/cli run build:cli`. The normal CLI packaging flow stages the bundled authoring skills alongside the executable.

If `--home` is omitted, the agent uses an `acp-agent` directory inside the default OpenPond home. The desktop and ACP processes must use separate homes: one runtime owns each home. Multiple sessions can share one ACP connection; multiple ACP processes cannot simultaneously write the same home. Use a different dedicated home for another simultaneous editor process, and sign in to that home separately.

Clients advertising terminal authentication receive a login action that appends `--login` to their configured launch arguments. After login, reconnect. Clients without that feature can run the setup command above and then use the advertised configured-account authentication method.

## Configure Zed manually

[Zed's custom agent configuration](https://zed.dev/docs/ai/external-agents) supports agents outside the registry. Add an entry to `agent_servers`:

```json
{
  "agent_servers": {
    "openpond": {
      "type": "custom",
      "command": "/absolute/path/to/openpond",
      "args": ["acp", "--home", "/absolute/path/to/openpond-acp-home"],
      "env": {}
    }
  }
}
```

Open a project and select OpenPond for a new external-agent conversation. This configuration follows Zed's documented schema. An interactive Zed/JetBrains session has not been verified. Current automated proof covers the official TypeScript ACP client, OpenPond's independent ACP client, and the experimental ACP TCK on Linux x64.

## Sessions, models and permissions

The client supplies one existing absolute workspace directory. New sessions use the selected home harness/profile and the OpenPond hosted model route. `--model ID` selects an available initial model; otherwise the agent selects `openpond-chat` when available. The session's model can subsequently change through the standard model configuration option.

Permissions default to **Ask permission**. Commands use the existing command approval service. Mutating harness tools and every supplied MCP tool require a client permission answer; denial, timeout, disconnection, and late answers after cancellation cannot authorize execution. **Full access** explicitly permits these tools without individual confirmation. Permission changes apply between prompts.

All file and command operations run locally through OpenPond's harness. The agent does not advertise editor filesystem or terminal delegation. The workspace is an execution root and session identity boundary, **not an OS sandbox**: approved commands run with the user's local privileges. ACP context does not grant additional permission.

Sessions persist under their OpenPond IDs. The selected harness release is pinned when the session is created. Loading requires the original home, account identity, model route, workspace, profile identity and MCP definitions. The agent replays durable history before replying. It rejects an unsettled turn instead of guessing whether to resend it. Each session admits one prompt at a time; cancellation interrupts its turn and settles pending interactions.

Client-provided MCP servers use stdio or Streamable HTTP and are scoped to their session. Server environment variables and HTTP headers remain in memory; only a fingerprint of their definitions enters session metadata. Supply the same definitions when loading a session. Session close and process disconnect close the MCP clients and their owned stdio children.

Text, images and embedded text resources are accepted. Resource links are supplied as references and are never automatically fetched. Audio and other embedded binary resources fail clearly before inference. Tool IDs, status and output are streamed; workspace patches appear as tool content and file locations. Task plans use a durable harness tool and are projected during generation and history replay. User questions use form elicitation when offered by the client; otherwise they appear in the conversation and the next prompt answers the pending question.

Session listing, deletion, lightweight resume, additional workspace roots, SSE MCP, remote/multi-tenant transport, background workflows and ACP v2 are not advertised. Richer OpenPond workflows remain on the native runtime API. The command does not proxy another installed agent, expose BYOK/local-model routing, or install itself into the upstream ACP registry.

## Developer qualification

Run the boundary suite and the packaged executable smoke:

```bash
pnpm exec vitest run tests/acp-agent.test.ts --project root-system --maxWorkers 1
pnpm exec tsx scripts/qualify-acp-agent.ts
```

The smoke uses a fresh home, the official CLI login, production runtime/tools/storage, a local scripted HTTP model fixture, and two independent ACP clients. It writes `tmp/acp-agent-qualification/report.json`. Set `OPENPOND_ACP_EXECUTABLE` to an installed `dist/cli.js` to qualify an extracted package. Set `OPENPOND_ACP_TCK_PATH` to a checkout of the [experimental TCK](https://github.com/agentclientprotocol/acp-tck) to run its v1 suite and save `tck.json` alongside the report. TCK results are bounded protocol evidence, not certification or proof of live hosted inference.
