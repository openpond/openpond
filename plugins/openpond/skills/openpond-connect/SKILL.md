---
name: openpond-connect
description: Connect this agent to OpenPond, verify its workspace and granted access, or diagnose a missing hosted MCP connection.
---

Use the OpenPond MCP connection supplied by this plugin. Start with `connection_context`, then a bounded inventory read relevant to the user's task. Confirm the authorized workspace matches the user's selection; a tool argument cannot switch workspaces.

If the client reports a missing connection or requires authentication, guide the user through its Connect/Sign in action. The client creates a browser authorization link with state and PKCE. The user signs in to OpenPond, selects a workspace and approves the displayed scopes. Return to this agent after the callback. Do not manufacture an authorization link or ask for tokens, passwords or cookies in chat.

The direct production MCP address is `https://api.openpond.ai/mcp/app`. Setup and client instructions: [OpenPond agent guide](https://openpond.ai/agent-setup.md). Keep the selected deployment's website, API and OAuth issuer together. Revocation is in OpenPond Account → External agents; reconnect through the client for a different workspace or additional scopes.

Hosted resource work requires no local CLI or SDK installation. For a user-requested repository integration, use the existing repo tools and the canonical guide to install only missing maintained packages or CLI skills. A hosted MCP cannot inspect a local path or install packages in a repository by itself. Report missing capabilities accurately.

Verify setup through reads only. A connection or plugin installation does not authorize data upload, publishing, learning activation, training, inference, serving or compute. Report authentication, actual workspace, granted scopes and successful reads separately from runtime qualification.
