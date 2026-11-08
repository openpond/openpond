# OpenPond agent plugin

`openpond/` is the portable remote-MCP plugin source, with shared hosted workflow skills and a thin Claude Code manifest. It connects to the production API with browser OAuth; it contains no credentials, local server, lifecycle hook or SDK runtime dependency.

Create the review ZIP with `node scripts/package-agent-plugin.mjs`. The ZIP is an upload candidate, not evidence of store approval or live client qualification. The script checks packaged paths, entry points, identity, the remote endpoint and square assets, and produces a content manifest. Validate `plugin.json` and `mcp.json` against their declared published schemas before submission; OpenAI Portal scans, real OAuth/client journeys, publisher verification and reviewer account/video remain release requirements. OAuth registration and endpoints come from the hosted server's discovery metadata. Plugin Creator is a separate optional preparation step.

For OpenCode, install the same skills with the standard Skills CLI from this folder, and configure its supported remote MCP connection independently. For Claude Code, this folder includes `.claude-plugin/plugin.json` and `.mcp.json`; installation, OAuth and actual client discovery still need acceptance in the chosen version. Public store packaging excludes the Claude compatibility files.

The hosted bundle focuses on resource workflows. The five CLI authoring skills remain maintained under `apps/cli/skills`; installing the CLI does not register them in another agent. Use the [canonical setup guide](https://openpond.ai/agent-setup.md) for those skills and opt-in local repository integration.
